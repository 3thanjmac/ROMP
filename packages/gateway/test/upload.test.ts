import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Files } from "../src/files.ts";
import { HttpError } from "../src/http.ts";
import { Roots } from "../src/paths.ts";

let root: string;
let dir: string;
let files: Files;

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "romp-upload-")));
	dir = join(root, "up");
	mkdirSync(dir);
	files = new Files(new Roots([root], root), root);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const body = (...parts: string[]) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
			controller.close();
		},
	});

async function status(promise: Promise<unknown>): Promise<number> {
	try {
		await promise;
		return 200;
	} catch (err) {
		if (err instanceof HttpError) return err.status;
		throw err;
	}
}

const read = (name: string) => readFileSync(join(dir, name), "utf8");

test("creates a file, refuses to clobber it without overwrite, replaces it with overwrite", async () => {
	const created = await files.upload(dir, "a.txt", false, body("hel", "lo"), 5);
	expect(created).toMatchObject({ path: join(dir, "a.txt"), size: 5 });
	expect(await status(files.upload(dir, "a.txt", false, body("x"), 1))).toBe(409);
	expect(read("a.txt")).toBe("hello");
	await files.upload(dir, "a.txt", true, body("bye"), 3);
	expect(read("a.txt")).toBe("bye");
	expect(readdirSync(dir)).toEqual(["a.txt"]);
});

test("oversized, short and aborted bodies leave no temp file behind", async () => {
	expect(await status(files.upload(dir, "big.bin", false, body("12345", "678"), null, 6))).toBe(413);
	expect(await status(files.upload(dir, "big.bin", false, body("12345678"), 8, 6))).toBe(413);
	expect(await status(files.upload(dir, "short.bin", false, body("123"), 10))).toBe(400);
	const aborted = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([1, 2, 3]));
			controller.error(new Error("client went away"));
		},
	});
	await expect(files.upload(dir, "aborted.bin", false, aborted, null)).rejects.toThrow("client went away");
	expect(readdirSync(dir)).toEqual(["a.txt"]);
});

test("the name must be a single plain path segment", async () => {
	for (const name of ["", ".", "..", "x/y", "x\\y", "x\0y", "../a.txt"]) {
		expect(await status(files.upload(dir, name, false, body("x"), 1))).toBe(400);
	}
	expect(await status(files.upload(join(dir, "a.txt"), "b", false, body("x"), 1))).toBe(400);
	expect(readdirSync(dir)).toEqual(["a.txt"]);
});
