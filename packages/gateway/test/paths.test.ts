import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "../src/http.ts";
import { Roots } from "../src/paths.ts";

let base: string;
let root: string;
let outside: string;
let roots: Roots;

beforeAll(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "romp-paths-")));
	root = join(base, "root");
	outside = join(base, "outside");
	mkdirSync(join(root, "sub"), { recursive: true });
	mkdirSync(outside);
	writeFileSync(join(root, "sub", "file.txt"), "hi");
	writeFileSync(join(outside, "secret"), "no");
	symlinkSync(outside, join(root, "escape"));
	symlinkSync(join(root, "sub"), join(root, "inner"));
	symlinkSync(join(base, "missing-target"), join(root, "dangling"));
	roots = new Roots([root], root);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

async function status(promise: Promise<unknown>): Promise<number> {
	try {
		await promise;
		return 200;
	} catch (err) {
		if (err instanceof HttpError) return err.status;
		throw err;
	}
}

describe("Roots.logical", () => {
	test("expands ~ and normalizes dot segments", () => {
		expect(roots.logical("~/sub/../sub/./file.txt")).toBe(join(root, "sub/file.txt"));
		expect(roots.logical("/a/b/")).toBe("/a/b");
	});
	test("rejects relative paths, empty input and NUL bytes", () => {
		expect(() => roots.logical("sub/file.txt")).toThrow(HttpError);
		expect(() => roots.logical("")).toThrow(HttpError);
		expect(() => roots.logical(`${root}/a\0b`)).toThrow(HttpError);
	});
});

describe("Roots.resolve", () => {
	test("allows paths inside the root, including through internal symlinks", async () => {
		expect(await roots.resolve(join(root, "sub/file.txt"))).toBe(join(root, "sub/file.txt"));
		expect(await roots.resolve(join(root, "inner/file.txt"))).toBe(join(root, "sub/file.txt"));
	});
	test("refuses lexical escapes", async () => {
		expect(await status(roots.resolve(roots.logical(`${root}/../outside/secret`)))).toBe(403);
	});
	test("refuses symlinks that point outside", async () => {
		expect(await status(roots.resolve(join(root, "escape/secret")))).toBe(403);
	});
	test("refuses not-yet-existing targets under an escaping symlink", async () => {
		expect(await status(roots.resolve(join(root, "escape/new/deeper.txt")))).toBe(403);
	});
	test("allows not-yet-existing targets inside the root", async () => {
		expect(await roots.resolve(join(root, "sub/new/deeper.txt"))).toBe(join(root, "sub/new/deeper.txt"));
	});
	test("refuses creating through a dangling symlink", async () => {
		expect(await status(roots.resolve(join(root, "dangling")))).toBe(400);
	});
	test("a sibling directory sharing the root's name prefix is outside", async () => {
		mkdirSync(`${root}-evil`, { recursive: true });
		expect(await status(roots.resolve(`${root}-evil`))).toBe(403);
	});
});

describe("Roots.resolveEntry", () => {
	test("does not follow the final symlink, so links can be renamed or trashed", async () => {
		expect(await roots.resolveEntry(join(root, "escape"))).toBe(join(root, "escape"));
	});
	test("refuses the root itself and entries reached through escaping parents", async () => {
		expect(await status(roots.resolveEntry(root))).toBe(403);
		expect(await status(roots.resolveEntry(join(root, "escape/secret")))).toBe(403);
	});
});
