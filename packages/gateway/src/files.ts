import { type FsEntry, type FsFile, type FsList, type FsOpRequest, type FsOpResult, type FsWriteResult, MAX_UPLOAD_BYTES } from "@romp/protocol";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { chmod, cp, link, lstat, mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { badRequest, conflict, notFound, requireString, tooLarge } from "./http.ts";
import type { Roots } from "./paths.ts";
import { errnoCode, newId, writeFileAtomic } from "./util.ts";

export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const SNIFF_BYTES = 8192;

function entryKind(st: Stats): FsEntry["kind"] {
	if (st.isSymbolicLink()) return "symlink";
	if (st.isDirectory()) return "dir";
	if (st.isFile()) return "file";
	return "other";
}

/** Name of an upload's temporary file while its bytes stream in (see `upload`). */
const UPLOAD_TMP = /^\.romp-upload-[0-9a-f]+\.tmp$/;

export class Files {
	/** `~/.local/share/romp/trash`. */
	private readonly trashRoot: string;

	constructor(
		private readonly roots: Roots,
		home: string,
	) {
		this.trashRoot = join(home, ".local/share/romp/trash");
	}

	async list(input: unknown): Promise<FsList> {
		const dir = await this.roots.resolve(this.roots.logical(input));
		const names = await readdir(dir);
		const entries: FsEntry[] = [];
		for (const name of names) {
			if (UPLOAD_TMP.test(name)) continue; // an upload still streaming in; it appears under its real name when done
			const path = join(dir, name);
			let st: Stats;
			try {
				st = await lstat(path);
			} catch {
				continue; // removed while listing
			}
			let kind = entryKind(st);
			// A symlink to a directory inside the roots behaves as a directory for browsing.
			if (kind === "symlink") {
				try {
					// `resolve` throws for targets outside the roots.
					if ((await stat(await this.roots.resolve(path))).isDirectory()) kind = "dir";
				} catch {
					// dangling or outside the roots: stays a symlink
				}
			}
			entries.push({ name, path, kind, size: st.size, mtimeMs: st.mtimeMs });
		}
		entries.sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name));
		const parent = dirname(dir);
		return {
			path: dir,
			parent: !this.roots.isRoot(dir) && parent !== dir && this.roots.contains(parent) ? parent : null,
			entries,
		};
	}

	async read(input: unknown): Promise<FsFile> {
		const path = await this.roots.resolve(this.roots.logical(input));
		const st = await stat(path);
		if (!st.isFile()) throw badRequest(`${path} is not a regular file`);
		const base = { path, size: st.size, mtimeMs: st.mtimeMs };
		if (st.size > MAX_TEXT_BYTES) return { ...base, content: null, binary: false, tooLarge: true };
		const bytes = await readFile(path);
		const binary = bytes.subarray(0, SNIFF_BYTES).includes(0);
		if (binary) return { ...base, content: null, binary: true, tooLarge: false };
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			return { ...base, content: null, binary: true, tooLarge: false };
		}
		return { ...base, content, binary: false, tooLarge: false };
	}

	async write(input: unknown, content: string, expectedMtimeMs: number | undefined): Promise<FsWriteResult> {
		const bytes = Buffer.from(content, "utf8");
		if (bytes.byteLength > MAX_TEXT_BYTES) throw badRequest("Files larger than 5 MiB cannot be saved from the editor");
		const path = await this.roots.resolve(this.roots.logical(input));
		let current: Stats | null = null;
		try {
			current = await stat(path);
		} catch (err) {
			if (errnoCode(err) !== "ENOENT") throw err;
		}
		if (current && !current.isFile()) throw badRequest(`${path} is not a regular file`);
		if (expectedMtimeMs !== undefined && (current?.mtimeMs ?? 0) !== expectedMtimeMs) {
			throw conflict(current ? "The file changed on disk since it was opened" : "The file was deleted since it was opened", {
				mtimeMs: current?.mtimeMs ?? 0,
			});
		}
		await writeFileAtomic(path, bytes, current ? current.mode & 0o7777 : undefined);
		let after = await stat(path);
		// Kernel timestamps are jiffy-coarse, so two saves a few ms apart can share an mtime and defeat the
		// conflict check. Nudge the new version past the old one.
		if (current && after.mtimeMs <= current.mtimeMs) {
			const mtime = new Date(Math.floor(current.mtimeMs) + 1);
			await utimes(path, after.atime, mtime);
			after = await stat(path);
		}
		return { path, mtimeMs: after.mtimeMs, size: after.size };
	}

	/**
	 * Streams `body` into `name` inside directory `dirInput`: bytes go to a temp file next to the target that is
	 * renamed into place once complete, and removed on any failure (too large, aborted, conflict). `declared` is the
	 * request's content-length, when it sent one; a body that ends short of it was cut off.
	 */
	async upload(
		dirInput: unknown,
		name: string,
		overwrite: boolean,
		body: ReadableStream<Uint8Array> | null,
		declared: number | null,
		limit = MAX_UPLOAD_BYTES,
	): Promise<FsWriteResult> {
		if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) throw badRequest(`Invalid file name: ${JSON.stringify(name)}`);
		if (Buffer.byteLength(name) > 255) throw badRequest("File name too long");
		if (declared !== null && declared > limit) throw tooLarge(limit);
		const dir = await this.roots.resolve(this.roots.logical(dirInput));
		if (!(await stat(dir)).isDirectory()) throw badRequest(`${dir} is not a directory`);
		const target = join(dir, name);
		const existing = await lstatOrNull(target);
		if (existing && !overwrite) throw conflict(`${name} already exists`);
		if (existing?.isDirectory()) throw badRequest(`${target} is a directory`);
		const tmp = join(dir, `.romp-upload-${newId()}.tmp`);
		const file = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o666);
		try {
			let size = 0;
			try {
				if (body) {
					for await (const chunk of body) {
						size += chunk.byteLength;
						if (size > limit) throw tooLarge(limit);
						await file.write(chunk);
					}
				}
			} finally {
				await file.close();
			}
			if (declared !== null && size !== declared) throw badRequest("The upload ended before the whole file arrived");
			if (existing?.isFile()) await chmod(tmp, existing.mode & 0o7777);
			if (overwrite) await rename(tmp, target);
			else await placeNew(tmp, target, name);
		} catch (err) {
			await rm(tmp, { force: true });
			throw err;
		}
		const after = await stat(target);
		return { path: target, mtimeMs: after.mtimeMs, size: after.size };
	}

	async op(req: FsOpRequest): Promise<FsOpResult> {
		switch (req.op) {
			case "mkdir": {
				const path = await this.roots.resolve(this.roots.logical(req.path));
				await mkdir(path);
				return { path };
			}
			case "create": {
				const path = await this.roots.resolve(this.roots.logical(req.path));
				await writeFile(path, "", { flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY });
				return { path };
			}
			case "rename": {
				const from = await this.roots.resolveEntry(this.roots.logical(req.path));
				const to = await this.roots.resolveEntry(this.roots.logical(req.to));
				await lstat(from);
				await this.assertAbsent(to);
				await rename(from, to);
				return { path: to };
			}
			case "trash":
				return this.trash(await this.roots.resolveEntry(this.roots.logical(req.path)));
			case "restore":
				return this.restore(req.trashId);
		}
	}

	private async trash(path: string): Promise<FsOpResult> {
		await lstat(path);
		const trashId = newId();
		const dir = join(this.trashRoot, trashId);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(join(dir, "meta.json"), `${JSON.stringify({ path, trashedAt: Date.now() })}\n`);
		await move(path, join(dir, "item"));
		return { path, trashId };
	}

	private async restore(trashId: string): Promise<FsOpResult> {
		if (!/^[0-9a-f]{16}$/.test(trashId)) throw badRequest("Invalid trashId");
		const dir = join(this.trashRoot, trashId);
		let meta: unknown;
		try {
			meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
		} catch (err) {
			if (errnoCode(err) === "ENOENT") throw notFound("That item is no longer in the trash");
			throw err;
		}
		const original = typeof meta === "object" && meta !== null && "path" in meta ? meta.path : undefined;
		if (typeof original !== "string") throw badRequest("Trash entry has no original path");
		const path = await this.roots.resolveEntry(this.roots.logical(original));
		await this.assertAbsent(path);
		await move(join(dir, "item"), path);
		await rm(dir, { recursive: true, force: true });
		return { path };
	}

	/** Realpath of a file for `/api/fs/raw`. */
	async rawPath(input: unknown): Promise<string> {
		const path = await this.roots.resolve(this.roots.logical(input));
		if (!(await stat(path)).isFile()) throw badRequest(`${path} is not a regular file`);
		return path;
	}

	private async assertAbsent(path: string): Promise<void> {
		try {
			await lstat(path);
		} catch (err) {
			if (errnoCode(err) === "ENOENT") return;
			throw err;
		}
		throw conflict(`${basename(path)} already exists`);
	}
}

/** `rename`, falling back to copy + delete across filesystems. */
async function move(from: string, to: string): Promise<void> {
	try {
		await rename(from, to);
	} catch (err) {
		if (errnoCode(err) !== "EXDEV") throw err;
		await cp(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
		await rm(from, { recursive: true, force: true });
	}
}

async function lstatOrNull(path: string): Promise<Stats | null> {
	try {
		return await lstat(path);
	} catch (err) {
		if (errnoCode(err) === "ENOENT") return null;
		throw err;
	}
}

/** Moves `tmp` to `target` without replacing a file that appeared meanwhile: hard link (fails on EEXIST), then unlink. */
async function placeNew(tmp: string, target: string, name: string): Promise<void> {
	try {
		await link(tmp, target);
	} catch (err) {
		const code = errnoCode(err);
		if (code === "EEXIST") throw conflict(`${name} already exists`);
		// Filesystems without hard links: accept the small check-then-rename race.
		if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw err;
		if (await lstatOrNull(target)) throw conflict(`${name} already exists`);
		await rename(tmp, target);
		return;
	}
	await rm(tmp, { force: true });
}

/** Validates a `POST /api/fs/op` body. */
export function parseFsOp(body: Record<string, unknown>): FsOpRequest {
	switch (body.op) {
		case "mkdir":
		case "create":
		case "trash":
			return { op: body.op, path: requireString(body, "path") };
		case "rename":
			return { op: "rename", path: requireString(body, "path"), to: requireString(body, "to") };
		case "restore":
			return { op: "restore", trashId: requireString(body, "trashId") };
		default:
			throw badRequest(`Unknown op ${JSON.stringify(body.op)}`);
	}
}
