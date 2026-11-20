import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimStateDir } from "../src/statelock.ts";
import { Updates } from "../src/updates.ts";

const root = mkdtempSync(join(tmpdir(), "romp-updates-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dir = () => join(root, String(++n));

test("a second gateway can't claim a state directory in use; a dead holder's claim is taken over", () => {
	const state = dir();
	const release = claimStateDir(state);
	expect(() => claimStateDir(state)).toThrow("another romp-gateway");
	release();
	claimStateDir(state)();
	// A crashed gateway leaves its file behind; pid 999999999 never exists.
	writeFileSync(join(state, "gateway.pid"), "999999999 12345\n");
	const again = claimStateDir(state);
	expect(() => claimStateDir(state)).toThrow("another romp-gateway");
	again();
	expect(existsSync(join(state, "gateway.pid"))).toBe(false);
});

test("without romp-update installed there is nothing to update", async () => {
	const updates = new Updates("alice", { dir: dir(), serviceRunning: async () => false });
	expect(await updates.status()).toEqual({ available: false, running: false, installed: null, last: null });
	await expect(updates.request()).rejects.toThrow("install.sh");
});

test("a request waits in requests/ and reads as running until the service picks it up", async () => {
	const state = dir();
	mkdirSync(join(state, "requests"), { recursive: true });
	writeFileSync(join(state, "last.json"), '{"state":"waiting","message":"Update to 1a2b3c4 waits.","at":1700000000000}\n');
	let active = false;
	const updates = new Updates("alice", { dir: state, src: root, serviceRunning: async () => active });
	expect(await updates.status()).toMatchObject({
		available: true,
		running: false,
		installed: null,
		last: { state: "waiting", message: "Update to 1a2b3c4 waits.", at: 1700000000000 },
	});
	expect((await updates.request()).running).toBe(true);
	expect(readdirSync(join(state, "requests"))).toEqual(["alice"]);
	// romp-update empties requests/ when it starts; the service itself then reports running.
	rmSync(join(state, "requests", "alice"));
	active = true;
	expect((await updates.status()).running).toBe(true);
	active = false;
	expect((await updates.status()).running).toBe(false);
});

test("an unreadable last.json is no result rather than an error", async () => {
	const state = dir();
	mkdirSync(join(state, "requests"), { recursive: true });
	writeFileSync(join(state, "last.json"), '{"state":"exploded","message":"?","at":1}');
	const updates = new Updates("alice", { dir: state, serviceRunning: async () => false });
	expect((await updates.status()).last).toBeNull();
});
