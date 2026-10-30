import fs from "node:fs";
import path from "node:path";
import { RompError } from "./errors.ts";

/** Mode for directories shared with the `romp` group: rwxrwsr-x. */
export const SHARED_DIR_MODE = 0o2775;
/** Mode for files other group members (and the queue service) may replace. */
export const SHARED_FILE_MODE = 0o664;

function errno(err: unknown): string | undefined {
	return (err as NodeJS.ErrnoException).code;
}

/**
 * Write via a temp file + rename so readers never see a partial file and other group
 * members can replace it later (rename only needs write access to the directory).
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode = SHARED_FILE_MODE): void {
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
	try {
		fs.writeFileSync(tmp, data, { mode });
		fs.chmodSync(tmp, mode);
		fs.renameSync(tmp, file);
	} catch (err) {
		fs.rmSync(tmp, { force: true });
		throw err;
	}
}

export function readJsonFile<T>(file: string): T | null {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (errno(err) === "ENOENT") return null;
		throw err;
	}
	return JSON.parse(text) as T;
}

/** `mkdir -p`; directories this call creates get `mode` applied explicitly (umask-proof). */
export function ensureDir(dir: string, mode?: number): void {
	if (fs.existsSync(dir)) return;
	ensureDir(path.dirname(dir), mode);
	try {
		fs.mkdirSync(dir);
	} catch (err) {
		if (errno(err) === "EEXIST") return;
		throw err;
	}
	if (mode !== undefined) fs.chmodSync(dir, mode);
}

/**
 * Make a freshly created repository tree group-writable: directories rwxrws, files g+rw.
 * Only touches entries owned by this process's user.
 */
export function makeGroupShared(dir: string): void {
	const uid = process.getuid?.();
	const visit = (p: string) => {
		const st = fs.lstatSync(p);
		if (st.isSymbolicLink()) return;
		if (uid !== undefined && st.uid !== uid) return;
		if (st.isDirectory()) {
			fs.chmodSync(p, (st.mode & 0o7777) | 0o2070);
			for (const name of fs.readdirSync(p)) visit(path.join(p, name));
		} else {
			fs.chmodSync(p, (st.mode & 0o7777) | 0o060);
		}
	};
	visit(dir);
}

function lockIsStale(file: string): boolean {
	let text: string;
	let mtimeMs: number;
	try {
		text = fs.readFileSync(file, "utf8");
		mtimeMs = fs.statSync(file).mtimeMs;
	} catch (err) {
		return errno(err) === "ENOENT";
	}
	const pid = Number.parseInt(text, 10);
	// An empty file is a lock being written right now; treat it as stale only once it is old.
	if (!Number.isInteger(pid) || pid <= 0) return Date.now() - mtimeMs > 30_000;
	try {
		process.kill(pid, 0);
		return false;
	} catch (err) {
		return errno(err) === "ESRCH";
	}
}

/**
 * Run `fn` holding an exclusive lock file (O_EXCL create). Locks left by dead processes
 * are broken; a live holder is waited for up to `waitMs`.
 */
export async function withLock<T>(file: string, fn: () => Promise<T>, waitMs = 10 * 60_000): Promise<T> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			fs.writeFileSync(file, `${process.pid}\n`, { flag: "wx", mode: SHARED_FILE_MODE });
			break;
		} catch (err) {
			if (errno(err) !== "EEXIST") throw err;
		}
		if (lockIsStale(file)) {
			fs.rmSync(file, { force: true });
			continue;
		}
		if (Date.now() > deadline) throw new RompError("conflict", `Busy: another romp operation holds ${file}`);
		await Bun.sleep(200);
	}
	try {
		return await fn();
	} finally {
		fs.rmSync(file, { force: true });
	}
}

/** Like `withLock` but returns null immediately when the lock is held by a live process. */
export async function tryWithLock<T>(file: string, fn: () => Promise<T>): Promise<T | null> {
	try {
		return await withLock(file, fn, 0);
	} catch (err) {
		if (err instanceof RompError && err.code === "conflict" && err.message.startsWith("Busy:")) return null;
		throw err;
	}
}

/** Truncate to at most `bytes` UTF-8 bytes, keeping the end. */
export function tailText(text: string, bytes: number): string {
	const buf = Buffer.from(text);
	if (buf.length <= bytes) return text;
	return `[output truncated]\n${new TextDecoder().decode(buf.subarray(buf.length - bytes))}`;
}

/** Truncate to at most `bytes` UTF-8 bytes, keeping the start. */
export function headText(text: string, bytes: number): string {
	const buf = Buffer.from(text);
	if (buf.length <= bytes) return text;
	return `${new TextDecoder().decode(buf.subarray(0, bytes))}\n[truncated]`;
}
