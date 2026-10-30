import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rompEnv } from "../src/env.ts";
import { type OmpDefaultsPaths, ompDefaultsPaths, setOmpDefaultsOptOut, syncOmpDefaults } from "../src/ompdefaults.ts";

const T = fs.mkdtempSync(path.join(os.tmpdir(), "romp-ompdefaults-"));

function setup(name: string): OmpDefaultsPaths {
	const home = path.join(T, name);
	return ompDefaultsPaths(rompEnv({ home, user: name, root: T }), path.join(home, "defaults"));
}
const put = (dir: string, rel: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), text);
};
const get = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
const yaml = (dir: string, rel: string) => Bun.YAML.parse(get(dir, rel)) as Record<string, unknown>;

describe("omp defaults", () => {
	test("a new user gets every default except model choices and onboarding state", () => {
		const p = setup("fresh");
		put(p.source, "config.yml", "theme:\n  dark: night\nmodelRoles:\n  default: anthropic/x\nretry:\n  maxRetries: 4\n  fallbackChains:\n    default: [openrouter/y]\nsetupVersion: 2\n");
		put(p.source, "models.yml", "providers: {}\n");
		put(p.source, "skills/review/SKILL.md", "# review\n");
		put(p.source, "agent.db", "secret");
		syncOmpDefaults(p);
		expect(yaml(p.agentDir, "config.yml")).toEqual({ theme: { dark: "night" }, retry: { maxRetries: 4 } });
		expect(get(p.agentDir, "skills/review/SKILL.md")).toBe("# review\n");
		expect(fs.existsSync(path.join(p.agentDir, "models.yml"))).toBe(false);
		expect(fs.existsSync(path.join(p.agentDir, "agent.db"))).toBe(false);
	});

	test("settings follow new defaults until the user changes them; model choices are never touched", () => {
		const p = setup("merge");
		put(p.source, "config.yml", "theme:\n  dark: night\ntools:\n  approvalMode: yolo\n");
		put(p.agentDir, "config.yml", "modelRoles:\n  default: openrouter/mine\ntools:\n  approvalMode: write\n");
		const first = syncOmpDefaults(p);
		// An existing value wins over a default the user never had.
		expect(yaml(p.agentDir, "config.yml")).toEqual({
			modelRoles: { default: "openrouter/mine" },
			tools: { approvalMode: "write" },
			theme: { dark: "night" },
		});
		expect(first.actions).toEqual([{ file: "config.yml", change: "updated", detail: "theme.dark; kept your tools.approvalMode" }]);

		put(p.source, "config.yml", "theme:\n  dark: dusk\ntools:\n  approvalMode: always-ask\nmodelRoles:\n  default: anthropic/admin\n");
		syncOmpDefaults(p);
		expect(yaml(p.agentDir, "config.yml")).toEqual({
			modelRoles: { default: "openrouter/mine" },
			tools: { approvalMode: "write" },
			theme: { dark: "dusk" },
		});

		// A setting the user changed after receiving it stays theirs; dropping a default removes untouched values.
		put(p.agentDir, "config.yml", "modelRoles:\n  default: openrouter/mine\ntools:\n  approvalMode: write\ntheme:\n  dark: mine\n");
		put(p.source, "config.yml", "tools:\n  approvalMode: always-ask\n  maxTimeout: 60\n");
		syncOmpDefaults(p);
		expect(yaml(p.agentDir, "config.yml")).toEqual({
			modelRoles: { default: "openrouter/mine" },
			tools: { approvalMode: "write", maxTimeout: 60 },
			theme: { dark: "mine" },
		});
	});

	test("other files update only while unedited, and deleted files stay deleted", () => {
		const p = setup("files");
		put(p.source, "RULES.md", "v1\n");
		put(p.source, "commands/fix.md", "f1\n");
		put(p.source, "hooks/notes.txt", "n1\n");
		syncOmpDefaults(p);
		put(p.agentDir, "commands/fix.md", "edited\n");
		fs.rmSync(path.join(p.agentDir, "hooks/notes.txt"));
		put(p.source, "RULES.md", "v2\n");
		put(p.source, "commands/fix.md", "f2\n");
		put(p.source, "hooks/notes.txt", "n2\n");
		const result = syncOmpDefaults(p);
		expect(get(p.agentDir, "RULES.md")).toBe("v2\n");
		expect(get(p.agentDir, "commands/fix.md")).toBe("edited\n");
		expect(fs.existsSync(path.join(p.agentDir, "hooks/notes.txt"))).toBe(false);
		expect(result.actions.map((a) => `${a.change} ${a.file}`)).toEqual(["updated RULES.md", "kept commands/fix.md", "kept hooks/notes.txt"]);

		fs.rmSync(path.join(p.source, "RULES.md"));
		syncOmpDefaults(p);
		expect(fs.existsSync(path.join(p.agentDir, "RULES.md"))).toBe(false);
	});

	test("status reports without writing, and opting out stops updates", () => {
		const p = setup("optout");
		put(p.source, "RULES.md", "v1\n");
		expect(syncOmpDefaults(p, { dryRun: true }).actions).toEqual([{ file: "RULES.md", change: "created" }]);
		expect(fs.existsSync(path.join(p.agentDir, "RULES.md"))).toBe(false);

		syncOmpDefaults(p);
		setOmpDefaultsOptOut(p, true);
		put(p.source, "RULES.md", "v2\n");
		expect(syncOmpDefaults(p)).toEqual({ optedOut: true, actions: [] });
		expect(get(p.agentDir, "RULES.md")).toBe("v1\n");

		setOmpDefaultsOptOut(p, false);
		syncOmpDefaults(p);
		expect(get(p.agentDir, "RULES.md")).toBe("v2\n");
	});
});
