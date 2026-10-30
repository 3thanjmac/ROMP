import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkpoint, shipTask } from "../src/checkpoint.ts";
import { type RompEnv, rompEnv } from "../src/env.ts";
import { RompError } from "../src/errors.ts";
import { preReceive, runOnce } from "../src/queue.ts";
import { addRepo, initRoot, listRepos, updateRepoSettings } from "../src/repos.ts";
import { createTask, getTask, listTasks, removeTask, taskForPath } from "../src/tasks.ts";

const T = fs.mkdtempSync(path.join(os.tmpdir(), "romp-test-"));
const root = path.join(T, "root");
const upstream = path.join(T, "upstream.git");
const CLI = path.resolve(import.meta.dir, "../src/cli.ts");

function user(name: string): RompEnv {
	const home = path.join(T, `home-${name}`);
	fs.mkdirSync(home, { recursive: true });
	return rompEnv({ root, user: name, home, workRoot: path.join(home, "romp") });
}

const ethan = user("ethan");
const alice = user("alice");
const queue = user("romp");

function sh(cwd: string, ...argv: string[]): string {
	const out = Bun.spawnSync(argv, {
		cwd,
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
	});
	if (out.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${out.stderr.toString()}`);
	return out.stdout.toString();
}

const upstreamFile = (file: string) => sh(T, "git", "--git-dir", upstream, "show", `main:${file}`);
const write = (dir: string, file: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
	fs.writeFileSync(path.join(dir, file), text);
};
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8");

const LINES = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");

beforeAll(async () => {
	// Hub hooks run `romp` from PATH.
	const bin = path.join(T, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "romp"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
	process.env.PATH = `${bin}:${process.env.PATH}`;
	process.env.ROMP_QUEUE_USER = "romp";
	process.env.GIT_CONFIG_NOSYSTEM = "1";

	const seed = path.join(T, "seed");
	sh(T, "git", "init", "-q", "--initial-branch=main", seed);
	write(seed, "notes.txt", `${LINES}\n`);
	write(seed, "config.json", '{\n  "name": "demo",\n  "version": 1\n}\n');
	write(seed, "value.txt", "x = 1\n");
	sh(seed, "git", "add", "-A");
	sh(seed, "git", "commit", "-q", "-m", "seed");
	sh(T, "git", "clone", "-q", "--bare", seed, upstream);
	await initRoot(ethan);
});

afterAll(() => {
	fs.rmSync(T, { recursive: true, force: true });
});

describe("romp", () => {
	test("init creates the shared tree", () => {
		for (const d of ["hub", "repos", "queue/incoming", "queue/processing", "queue/done", "queue/failed", "status", "work", "logs"])
			expect(fs.statSync(path.join(root, d)).isDirectory()).toBe(true);
		expect(fs.statSync(path.join(root, "hub")).mode & 0o7777).toBe(0o2775);
	});

	test("repo add + list + settings", async () => {
		const repo = await addRepo(ethan, { url: upstream, name: "demo" });
		expect(repo).toMatchObject({ name: "demo", remote: upstream, branch: "main", land: "push", setup: null, test: null });
		await expect(addRepo(alice, { url: upstream, name: "demo" })).rejects.toBeInstanceOf(RompError);
		const updated = await updateRepoSettings(alice, "demo", { test: "test -f notes.txt" });
		expect(updated.test).toBe("test -f notes.txt");
		expect((await listRepos(alice)).map((r) => r.name)).toEqual(["demo"]);
		expect(fs.existsSync(path.join(root, "hub", "demo.git", "hooks", "post-receive"))).toBe(true);
	});

	test("tasks: create, list, taskForPath", async () => {
		const a = await createTask(ethan, { repo: "demo", title: "Edit the top" });
		expect(a).toMatchObject({ slug: "edit-the-top", branch: "agent/ethan/edit-the-top", status: "active", dirty: false });
		const b = await createTask(alice, { repo: "demo", title: "Edit the bottom", slug: "bottom" });
		expect(b.path).toBe(path.join(alice.workRoot, "demo", "bottom"));
		const dup = await createTask(ethan, { repo: "demo", title: "Edit the top" });
		expect(dup.slug).toBe("edit-the-top-2");
		await removeTask(ethan, "demo", dup.slug);
		expect(taskForPath(ethan, path.join(a.path, "sub", "file"))).toEqual({ repo: "demo", slug: "edit-the-top" });
		expect(taskForPath(ethan, ethan.workRoot)).toBeNull();
		expect((await listTasks(ethan)).map((t) => t.slug)).toEqual(["edit-the-top"]);
	});

	test("checkpoint commits and is a no-op when clean", async () => {
		const wt = (await getTask(ethan, "demo", "edit-the-top")).path;
		write(wt, "notes.txt", `${LINES.replace("line 2\n", "line 2 (ethan)\n")}\n`);
		expect((await getTask(ethan, "demo", "edit-the-top")).dirty).toBe(true);
		const saved = await checkpoint(ethan, "demo", "edit-the-top");
		expect(saved.status).toBe("saved");
		expect((await checkpoint(ethan, "demo", "edit-the-top")).status).toBe("clean");
		const info = await getTask(ethan, "demo", "edit-the-top");
		expect(info).toMatchObject({ dirty: false, ahead: 1, behind: 0 });
		// Backed up to the hub.
		expect(sh(T, "git", "--git-dir", path.join(root, "hub", "demo.git"), "rev-parse", "agent/ethan/edit-the-top").trim()).toBe(saved.head);
	});

	test("ship + run-once lands in push mode", async () => {
		const shipped = await shipTask(ethan, "demo", "edit-the-top", { message: "Mark line 2" });
		expect(shipped.status).toBe("queued");
		expect(fs.readdirSync(path.join(root, "queue", "incoming")).filter((f) => f.endsWith(".json"))).toHaveLength(1);
		expect(await runOnce(queue)).toBe(1);
		const info = await getTask(ethan, "demo", "edit-the-top");
		expect(info.status).toBe("landed");
		expect(info.landing?.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(upstreamFile("notes.txt")).toContain("line 2 (ethan)");
		expect(sh(T, "git", "--git-dir", upstream, "log", "-1", "--format=%s %an", "main").trim()).toBe("Mark line 2 ethan");
		// The land ref is gone from the hub.
		expect(sh(T, "git", "--git-dir", path.join(root, "hub", "demo.git"), "for-each-ref", "refs/heads/land").trim()).toBe("");
	});

	test("work continued after landing syncs without conflicting with its own squash", async () => {
		const wt = (await getTask(ethan, "demo", "edit-the-top")).path;
		write(wt, "notes.txt", `${LINES.replace("line 2\n", "line 2 (ethan, again)\n")}\n`);
		const saved = await checkpoint(ethan, "demo", "edit-the-top");
		expect(saved.status).toBe("saved");
		expect(sh(wt, "git", "log", "-3", "--format=%s")).toContain("romp: record landing of");
		expect((await getTask(ethan, "demo", "edit-the-top")).status).toBe("active");
		await shipTask(ethan, "demo", "edit-the-top", { message: "Mark line 2 again" });
		await runOnce(queue);
		expect((await getTask(ethan, "demo", "edit-the-top")).status).toBe("landed");
		expect(upstreamFile("notes.txt")).toContain("line 2 (ethan, again)");
	});

	test("sync merges same-file edits in different regions; mergiraf merges adjacent JSON keys", async () => {
		const wt = (await getTask(alice, "demo", "bottom")).path;
		write(wt, "notes.txt", `${LINES.replace("line 29", "line 29 (alice)")}\n`);
		write(wt, "config.json", '{\n  "name": "demo",\n  "version": 1,\n  "alice": true\n}\n');
		await checkpoint(alice, "demo", "bottom");

		const e = await createTask(ethan, { repo: "demo", title: "config", slug: "config" });
		write(e.path, "config.json", '{\n  "name": "demo",\n  "version": 1,\n  "ethan": true\n}\n');
		await shipTask(ethan, "demo", "config", { message: "Add ethan key" });
		await runOnce(queue);
		expect((await getTask(ethan, "demo", "config")).status).toBe("landed");

		const synced = await checkpoint(alice, "demo", "bottom");
		expect(synced.status).toBe("saved");
		const merged = JSON.parse(read(wt, "config.json"));
		expect(merged).toEqual({ name: "demo", version: 1, alice: true, ethan: true });
		expect(read(wt, "notes.txt")).toContain("line 2 (ethan, again)");
		expect(read(wt, "notes.txt")).toContain("line 29 (alice)");

		await shipTask(alice, "demo", "bottom", { message: "Alice edits" });
		await runOnce(queue);
		expect((await getTask(alice, "demo", "bottom")).status).toBe("landed");
		expect(JSON.parse(upstreamFile("config.json"))).toEqual({ name: "demo", version: 1, alice: true, ethan: true });
	});

	test("true conflict: conflict status, then completed once markers are gone", async () => {
		const a = await createTask(alice, { repo: "demo", title: "value two", slug: "two" });
		write(a.path, "value.txt", "x = 2\n");
		await checkpoint(alice, "demo", "two");

		const e = await createTask(ethan, { repo: "demo", title: "value three", slug: "three" });
		write(e.path, "value.txt", "x = 3\n");
		await shipTask(ethan, "demo", "three", { message: "x is three" });
		await runOnce(queue);

		const result = await checkpoint(alice, "demo", "two");
		expect(result.status).toBe("conflict");
		expect(result.conflictFiles).toEqual(["value.txt"]);
		expect(read(a.path, "value.txt")).toContain("<<<<<<<");
		const info = await getTask(alice, "demo", "two");
		expect(info).toMatchObject({ status: "conflict", conflictFiles: ["value.txt"] });
		await expect(shipTask(alice, "demo", "two", { message: "nope" })).rejects.toMatchObject({ code: "conflict" });
		// Still conflicted: checkpoint keeps reporting it and does not commit markers.
		expect((await checkpoint(alice, "demo", "two")).status).toBe("conflict");

		write(a.path, "value.txt", "x = 5\n");
		expect((await checkpoint(alice, "demo", "two")).status).toBe("saved");
		const after = await getTask(alice, "demo", "two");
		expect(after).toMatchObject({ status: "active", conflictFiles: [], behind: 0 });
		// History kept: alice's own commit is still reachable.
		expect(sh(a.path, "git", "log", "--format=%s").split("\n")).toContain("romp: checkpoint");

		await shipTask(alice, "demo", "two", { message: "x is five" });
		await runOnce(queue);
		expect((await getTask(alice, "demo", "two")).status).toBe("landed");
		expect(upstreamFile("value.txt")).toBe("x = 5\n");
	});

	test("failing test command marks the landing failed with its log", async () => {
		await updateRepoSettings(ethan, "demo", { test: "echo boom-output; exit 7" });
		const t = await createTask(ethan, { repo: "demo", title: "breaks tests", slug: "breaks" });
		write(t.path, "new.txt", "hello\n");
		const before = upstreamFile("notes.txt");
		await shipTask(ethan, "demo", "breaks", { message: "Add new" });
		await runOnce(queue);
		const info = await getTask(ethan, "demo", "breaks");
		expect(info.status).toBe("failed");
		expect(info.landing?.message).toContain("Tests failed");
		expect(info.landing?.log).toContain("boom-output");
		expect(upstreamFile("notes.txt")).toBe(before);
		expect(fs.readdirSync(path.join(root, "queue", "failed")).length).toBe(1);
		// New work after a failure makes the task active again.
		write(t.path, "new.txt", "hello again\n");
		expect((await getTask(ethan, "demo", "breaks")).status).toBe("active");
		await updateRepoSettings(ethan, "demo", { test: null });
		await removeTask(ethan, "demo", "breaks");
		expect(fs.existsSync(t.path)).toBe(false);
	});

	test("hub-only repo lands on the hub branch", async () => {
		const repo = await addRepo(ethan, { url: "", name: "solo" });
		expect(repo).toMatchObject({ remote: null, branch: "main" });
		await expect(updateRepoSettings(ethan, "solo", { land: "pr" })).rejects.toMatchObject({ code: "bad_request" });
		const t = await createTask(alice, { repo: "solo", title: "first file" });
		write(t.path, "README.md", "# solo\n");
		await shipTask(alice, "solo", t.slug, { message: "Add readme" });
		expect(await runOnce(queue)).toBe(1);
		expect((await getTask(alice, "solo", t.slug)).status).toBe("landed");
		expect(sh(T, "git", "--git-dir", path.join(root, "hub", "solo.git"), "show", "main:README.md")).toBe("# solo\n");
	});

	test("jobs left in processing/ by a crashed queue are retried", async () => {
		const t = await createTask(ethan, { repo: "solo", title: "after crash" });
		write(t.path, "crash.txt", "ok\n");
		await shipTask(ethan, "solo", t.slug, { message: "Add crash.txt" });
		const incoming = path.join(root, "queue", "incoming");
		for (const f of fs.readdirSync(incoming).filter((n) => n.endsWith(".json")))
			fs.renameSync(path.join(incoming, f), path.join(root, "queue", "processing", f));
		// A dead holder's lock does not block recovery.
		fs.writeFileSync(path.join(root, "work", ".solo.lock"), "999999\n");
		expect(await runOnce(queue)).toBe(1);
		expect((await getTask(ethan, "solo", t.slug)).status).toBe("landed");
		expect(fs.readdirSync(path.join(root, "queue", "processing"))).toEqual([]);
	});

	test("hub pre-receive only lets users write their own refs", () => {
		const z = "0".repeat(40);
		const prev = process.env.ROMP_USER;
		process.env.ROMP_USER = "alice";
		try {
			expect(preReceive(`${z} ${"1".repeat(40)} refs/heads/land/alice/x\n`)).toEqual([]);
			expect(preReceive(`${z} ${"1".repeat(40)} refs/heads/land/ethan/x\n`)).toHaveLength(1);
			expect(preReceive(`${z} ${"1".repeat(40)} refs/heads/main\n`)).toHaveLength(1);
			process.env.ROMP_USER = "romp";
			expect(preReceive(`${z} ${"1".repeat(40)} refs/heads/main\n`)).toEqual([]);
		} finally {
			process.env.ROMP_USER = prev;
		}
	});

	test("cli: checkpoint --json exits 3 on conflict", async () => {
		const a = await createTask(alice, { repo: "demo", title: "cli conflict", slug: "cli" });
		write(a.path, "value.txt", "x = 100\n");
		await checkpoint(alice, "demo", "cli");
		const e = await createTask(ethan, { repo: "demo", title: "cli other", slug: "cli-other" });
		write(e.path, "value.txt", "x = 200\n");
		await shipTask(ethan, "demo", "cli-other", { message: "x is 200" });
		await runOnce(queue);
		const out = Bun.spawnSync([process.execPath, CLI, "checkpoint", a.path, "--json"], {
			env: { ...process.env, ROMP_ROOT: root, ROMP_WORK: alice.workRoot, HOME: alice.home, ROMP_USER: "alice", USER: "alice" },
		});
		// The CLI acts as the OS user; only the exit code and JSON shape matter here.
		const parsed = JSON.parse(out.stdout.toString());
		expect(out.exitCode).toBe(3);
		expect(parsed).toMatchObject({ status: "conflict", conflictFiles: ["value.txt"] });
	});
});
