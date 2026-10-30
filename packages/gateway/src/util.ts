import { randomBytes } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 64-bit random id, hex encoded. */
export function newId(): string {
	return randomBytes(8).toString("hex");
}

export function errnoCode(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
	return typeof err.code === "string" ? err.code : undefined;
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Expands a leading `~` or `~/` to `home`. */
export function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

/** Writes to a temp file next to `path`, then renames it into place so readers never see a partial file. */
export async function writeFileAtomic(path: string, data: string | Uint8Array, mode?: number): Promise<void> {
	const tmp = join(dirname(path), `.${basename(path)}.${newId()}.tmp`);
	try {
		await writeFile(tmp, data);
		if (mode !== undefined) await chmod(tmp, mode);
		await rename(tmp, path);
	} catch (err) {
		await rm(tmp, { force: true });
		throw err;
	}
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	const { promise: timeout, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(message)), ms);
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
