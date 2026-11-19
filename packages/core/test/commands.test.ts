import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rompEnv } from "../src/env.ts";
import { commandSources, detectCommands, effectiveCommands, parseRompToml } from "../src/repos.ts";
import { resolveDevCommand } from "../src/tasks.ts";

const T = fs.mkdtempSync(path.join(os.tmpdir(), "romp-commands-"));
const env = rompEnv({ root: path.join(T, "root"), user: "u", home: T, workRoot: path.join(T, "work") });
const PKG = JSON.stringify({ scripts: { test: "vitest", dev: "vite" } });
const none = { setup: null, test: null, dev: null };

function dir(name: string, files: Record<string, string>): string {
	const d = path.join(T, name);
	fs.mkdirSync(d, { recursive: true });
	for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(d, file), text);
	return d;
}

afterAll(() => fs.rmSync(T, { recursive: true, force: true }));

describe("detectCommands", () => {
	test("lockfile picks the install command and the script runner", () => {
		const cases: [string, string, string][] = [
			["pnpm-lock.yaml", "pnpm install --frozen-lockfile", "pnpm dev"],
			["bun.lock", "bun install --frozen-lockfile", "bun run dev"],
			["bun.lockb", "bun install --frozen-lockfile", "bun run dev"],
			["yarn.lock", "yarn install --frozen-lockfile", "yarn dev"],
			["package-lock.json", "npm ci", "npm run dev"],
		];
		for (const [lock, setup, dev] of cases) {
			const { commands, from } = detectCommands(new Set([lock]), PKG);
			expect(commands).toEqual({ setup, test: dev.replace(/dev$/, "test"), dev });
			expect(from).toEqual({ setup: lock, test: "package.json", dev: "package.json" });
		}
	});

	test("pnpm wins over other lockfiles; no lockfile runs scripts with npm; bad package.json counts as none", () => {
		expect(detectCommands(new Set(["package-lock.json", "pnpm-lock.yaml"]), null).commands.setup).toBe(
			"pnpm install --frozen-lockfile",
		);
		expect(detectCommands(new Set(), PKG).commands).toEqual({ setup: null, test: "npm run test", dev: "npm run dev" });
		expect(detectCommands(new Set(["yarn.lock"]), "{nope").commands).toEqual({
			setup: "yarn install --frozen-lockfile",
			test: null,
			dev: null,
		});
		expect(detectCommands(new Set(), JSON.stringify({ scripts: { dev: " " } })).commands.dev).toBeNull();
	});
});

describe("effectiveCommands", () => {
	const detected = detectCommands(new Set(["pnpm-lock.yaml"]), PKG);

	test("hub settings > .romp.toml > detected; an empty override disables", () => {
		const fromRepo = parseRompToml('dev = "make dev"\n');
		expect(effectiveCommands(none, fromRepo, detected)).toEqual({
			setup: "pnpm install --frozen-lockfile",
			test: "pnpm test",
			dev: "make dev",
		});
		expect(effectiveCommands({ setup: "", test: "t", dev: null }, fromRepo, detected)).toEqual({
			setup: null,
			test: "t",
			dev: "make dev",
		});
	});

	test("sources report the override and what Reset falls back to", () => {
		const sources = commandSources({ setup: null, test: "t", dev: "d" }, parseRompToml('dev = "make dev"\n'), detected);
		expect(sources.setup).toEqual({
			source: "detected",
			fallback: "pnpm install --frozen-lockfile",
			fallbackSource: "detected",
			detectedFrom: "pnpm-lock.yaml",
		});
		expect(sources.test).toEqual({ source: "settings", fallback: "pnpm test", fallbackSource: "detected", detectedFrom: "package.json" });
		expect(sources.dev).toEqual({ source: "settings", fallback: "make dev", fallbackSource: "repo", detectedFrom: null });
		expect(commandSources(none, none, detectCommands(new Set(), null)).dev).toEqual({
			source: null,
			fallback: null,
			fallbackSource: null,
			detectedFrom: null,
		});
	});
});

describe("resolveDevCommand outside a task", () => {
	test(".romp.toml in the directory wins over detection", async () => {
		const d = dir("toml", { ".romp.toml": 'dev = "make serve"\n', "package.json": PKG, "pnpm-lock.yaml": "" });
		expect(await resolveDevCommand(env, d)).toBe("make serve");
	});

	test("detects from the lockfile and package.json", async () => {
		expect(await resolveDevCommand(env, dir("bun", { "package.json": PKG, "bun.lock": "" }))).toBe("bun run dev");
		expect(await resolveDevCommand(env, dir("npm", { "package.json": PKG, "package-lock.json": "{}" }))).toBe("npm run dev");
	});

	test("null when nothing is configured or detected", async () => {
		expect(await resolveDevCommand(env, dir("empty", { "pnpm-lock.yaml": "" }))).toBeNull();
		expect(await resolveDevCommand(env, path.join(T, "missing"))).toBeNull();
	});
});
