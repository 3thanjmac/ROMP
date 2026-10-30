import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { badRequest, forbidden } from "./http.ts";
import { errnoCode, expandHome } from "./util.ts";

/**
 * The directories the gateway may touch. Every path is checked after symlink resolution, so a link that
 * points outside the roots is refused even when its own location is inside them.
 */
export class Roots {
	constructor(
		/** Realpaths. */
		readonly dirs: readonly string[],
		private readonly home: string,
	) {}

	/** Normalizes a client path: expands `~`, requires an absolute path, resolves `.` and `..` lexically. */
	logical(input: unknown): string {
		if (typeof input !== "string" || input === "") throw badRequest("A path is required");
		if (input.includes("\0")) throw badRequest("Paths cannot contain NUL bytes");
		const expanded = expandHome(input, this.home);
		if (!expanded.startsWith("/")) throw badRequest(`Path must be absolute: ${input}`);
		const normalized = posix.normalize(expanded);
		return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	}

	contains(real: string): boolean {
		return this.dirs.some((root) => real === root || real.startsWith(root === "/" ? "/" : `${root}/`));
	}

	isRoot(real: string): boolean {
		return this.dirs.includes(real);
	}

	/**
	 * Realpath of `logical`, following symlinks. Trailing components that do not exist yet are allowed (they
	 * are about to be created) and are appended to the realpath of the deepest existing ancestor.
	 */
	async resolve(logical: string): Promise<string> {
		const real = await realpathAllowMissing(logical);
		if (!this.contains(real)) throw outside(logical);
		return real;
	}

	/** Real location of the entry itself: its parent is resolved, its final component is not followed. */
	async resolveEntry(logical: string): Promise<string> {
		if (logical === "/") throw badRequest("Cannot operate on /");
		const real = join(await realpath(dirname(logical)), basename(logical));
		if (!this.contains(real)) throw outside(logical);
		if (this.isRoot(real)) throw forbidden(`${logical} is a root directory`);
		return real;
	}
}

function outside(path: string) {
	return forbidden(`${path} is outside the allowed roots`);
}

export async function realpathAllowMissing(path: string): Promise<string> {
	const missing: string[] = [];
	let current = path;
	for (;;) {
		try {
			const real = await realpath(current);
			return missing.length === 0 ? real : join(real, ...missing.reverse());
		} catch (err) {
			if (errnoCode(err) !== "ENOENT") throw err;
		}
		// realpath fails with ENOENT for a link whose target is missing; creating through it would escape.
		if (await isSymlink(current)) throw badRequest(`${current} is a dangling symlink`);
		const parent = dirname(current);
		if (parent === current) throw badRequest(`Cannot resolve ${path}`);
		missing.push(basename(current));
		current = parent;
	}
}

async function isSymlink(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isSymbolicLink();
	} catch {
		return false;
	}
}
