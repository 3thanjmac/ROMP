import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTitle, ompTitleGenerator } from "../src/agents/title.ts";
import { type GhRunner, RepoSearch } from "../src/github.ts";
import { HttpError } from "../src/http.ts";

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "romp-title-"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function script(name: string, body: string): string {
	const file = join(dir, name);
	writeFileSync(file, `#!/bin/sh\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
}

test("cleanTitle keeps the first line without markdown, quotes or trailing punctuation", () => {
	expect(cleanTitle('\n  "**Fix login redirect.**"\nsecond line')).toBe("Fix login redirect");
	expect(cleanTitle("# Title: Add dark mode toggle!")).toBe("Add dark mode toggle");
	expect(cleanTitle("one two three four five six seven")).toBe("one two three four five…");
	expect(cleanTitle("  \n")).toBe("");
});

test("ompTitleGenerator runs omp in print mode and reads stdout only", async () => {
	const args = join(dir, "args");
	const omp = script("omp-ok", `printf '%s\\n' "$@" > ${args}\necho Working... >&2\nprintf '\\n"Add dark mode."\\n'`);
	expect(await ompTitleGenerator(omp)(dir, "please add a dark mode")).toBe("Add dark mode");
	const argv = readFileSync(args, "utf8");
	for (const flag of ["-p", "--no-session", "@tiny", "--no-tools", "--thinking"]) expect(argv).toContain(`${flag}\n`);
	expect(argv).toContain("please add a dark mode");
});

test("ompTitleGenerator yields null on failure, empty output, a missing binary or a timeout", async () => {
	expect(await ompTitleGenerator(script("omp-fail", "echo 'No default model' >&2\nexit 1"))(dir, "x")).toBeNull();
	expect(await ompTitleGenerator(script("omp-empty", "echo"))(dir, "x")).toBeNull();
	expect(await ompTitleGenerator(join(dir, "missing"))(dir, "x")).toBeNull();
	// A real subprocess timeout: the generator's kill path is what is under test.
	expect(await ompTitleGenerator(script("omp-slow", "sleep 5\necho late"), 100)(dir, "x")).toBeNull();
});

const repo = (fullName: string, pushedAt: string) =>
	JSON.stringify([fullName, `https://github.com/${fullName}.git`, null, false, pushedAt]);

test("RepoSearch loads once, ranks prefix matches first, then most recently pushed", async () => {
	let calls = 0;
	const run: GhRunner = async () => {
		calls++;
		const lines = [
			repo("ethan/romp", "2026-10-01T00:00:00Z"),
			repo("acme/frontend-romp", "2026-10-20T00:00:00Z"),
			repo("romp-org/tools", "2026-09-01T00:00:00Z"),
			repo("ethan/other", "2026-10-25T00:00:00Z"),
		];
		return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
	};
	const search = new RepoSearch(run);
	const [matches, all] = await Promise.all([search.search("ROMP"), search.search("")]);
	expect(calls).toBe(1);
	expect(matches.map((r) => r.fullName)).toEqual(["ethan/romp", "romp-org/tools", "acme/frontend-romp"]);
	expect(all.map((r) => r.fullName)).toEqual(["ethan/other", "acme/frontend-romp", "ethan/romp", "romp-org/tools"]);
	expect(all[0]).toMatchObject({ url: "https://github.com/ethan/other.git", private: false, pushedAt: Date.parse("2026-10-25T00:00:00Z") });
	await search.search("other");
	expect(calls).toBe(1);
});

test("RepoSearch reports a signed-out or missing gh as 503 gh_unavailable and does not cache failures", async () => {
	let calls = 0;
	const search = new RepoSearch(async () => {
		calls++;
		return calls === 1
			? { code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" }
			: { code: 127, stdout: "", stderr: "gh: not found" };
	});
	for (let i = 0; i < 2; i++) {
		const err = await search.search("x").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(HttpError);
		expect(err).toMatchObject({ status: 503, code: "gh_unavailable" });
	}
	expect(calls).toBe(2);
});
