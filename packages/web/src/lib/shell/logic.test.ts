import type { TaskInfo } from "@romp/protocol";
import { describe, expect, it } from "vitest";
import { isAbsolute, normalizeAddress, proxiedPort } from "../../panes/browser/address";
import { anyShipping, groupTasks, pinFirst, remoteLabel, repoSearchQuery } from "../../panes/tasks/group";
import { applyModifiers, KEY_SEQ, nextModState } from "../../panes/terminal/keys";
import { fuzzyFilter, fuzzyScore } from "./fuzzy";
import { matchShortcut } from "./keyboard";
import { normalizeState } from "./normalize";

const key = (code: string, mods: Partial<KeyboardEvent> = {}) =>
	({ code, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, ...mods }) as KeyboardEvent;

describe("shortcuts", () => {
	it("matches on e.code with Alt", () => {
		expect(matchShortcut(key("ArrowLeft"))).toEqual({ type: "focus", dir: "left" });
		expect(matchShortcut(key("ArrowRight", { shiftKey: true }))).toEqual({ type: "move", dir: "right" });
		expect(matchShortcut(key("ArrowUp", { ctrlKey: true }))).toEqual({ type: "resize", dir: "up" });
		expect(matchShortcut(key("Digit3"))).toEqual({ type: "workspace", n: 3 });
		expect(matchShortcut(key("Digit3", { shiftKey: true }))).toEqual({ type: "moveToWorkspace", n: 3 });
		expect(matchShortcut(key("Slash", { shiftKey: true }))).toEqual({ type: "shortcuts" });
		expect(matchShortcut(key("BracketRight"))).toEqual({ type: "cycleWorkspace", delta: 1 });
	});
	it("lets other chords through", () => {
		expect(matchShortcut(key("KeyB"))).toBeNull();
		expect(matchShortcut(key("KeyO", { altKey: false }))).toBeNull();
		expect(matchShortcut(key("KeyO", { metaKey: true }))).toBeNull();
		expect(matchShortcut(key("KeyQ", { ctrlKey: true }))).toBeNull();
	});
});

describe("fuzzy", () => {
	it("requires a subsequence and prefers word starts", () => {
		expect(fuzzyScore("xyz", "New terminal")).toBeNull();
		const out = fuzzyFilter(["Toggle layout mode", "New terminal", "Rename workspace"], "nt", (s) => s);
		expect(out[0]).toBe("New terminal");
		expect(fuzzyFilter(["b", "a"], "", (s) => s)).toEqual(["b", "a"]);
	});
});

describe("terminal modifiers", () => {
	it("encodes Ctrl and Alt", () => {
		expect(applyModifiers("c", true, false)).toBe("\x03");
		expect(applyModifiers("x", false, true)).toBe("\x1bx");
		expect(applyModifiers("a", true, true)).toBe("\x1b\x01");
		expect(applyModifiers(KEY_SEQ.up, true, false)).toBe("\x1b[1;5A");
		expect(applyModifiers("hello", false, false)).toBe("hello");
	});
	it("latches, locks on double tap, and releases", () => {
		expect(nextModState("off", false)).toBe("latched");
		expect(nextModState("latched", true)).toBe("locked");
		expect(nextModState("latched", false)).toBe("off");
		expect(nextModState("locked", false)).toBe("off");
	});
});

describe("browser address", () => {
	it("normalizes ports, proxy paths and URLs", () => {
		expect(normalizeAddress("5173")).toBe("/proxy/5173/");
		expect(normalizeAddress(":3000/app")).toBe("/proxy/3000/app");
		expect(normalizeAddress("/absproxy/5173")).toBe("/absproxy/5173/");
		expect(normalizeAddress("example.com")).toBe("https://example.com");
		expect(normalizeAddress("70000")).toBeNull();
		expect(proxiedPort("/proxy/8080/x")).toBe(8080);
		expect(isAbsolute("http://a")).toBe(true);
	});
});

const task = (status: TaskInfo["status"], createdAt: number): TaskInfo => ({
	repo: "app",
	slug: `t${createdAt}`,
	branch: "agent/u/t",
	path: "/x",
	title: "t",
	createdAt,
	status,
	dirty: false,
	ahead: 0,
	behind: 0,
	conflictFiles: [],
	landing: null,
});

describe("tasks", () => {
	it("groups by attention, newest first, skipping empty groups", () => {
		const groups = groupTasks([task("active", 1), task("failed", 2), task("active", 3), task("landed", 4)]);
		expect(groups.map((g) => g.group)).toEqual(["attention", "progress", "landed"]);
		expect(groups[1]!.tasks.map((t) => t.createdAt)).toEqual([3, 1]);
		expect(anyShipping([task("landing", 1)])).toBe(true);
	});
	it("pins the remembered repo first and keeps the rest in order", () => {
		const repos = [{ name: "a" }, { name: "b" }, { name: "c" }];
		expect(pinFirst(repos, "c").map((r) => r.name)).toEqual(["c", "a", "b"]);
		expect(pinFirst(repos, "gone").map((r) => r.name)).toEqual(["a", "b", "c"]);
		expect(pinFirst(repos, null)).not.toBe(repos);
	});
	it("labels remotes as host/path", () => {
		expect(remoteLabel("https://github.com/you/app.git")).toBe("github.com/you/app");
		expect(remoteLabel("git@github.com:you/app.git")).toBe("github.com/you/app");
		expect(remoteLabel(null)).toBe("hub only");
	});
	it("searches GitHub only for plain text, never URLs or paths", () => {
		expect(repoSearchQuery("  romp ")).toBe("romp");
		for (const text of ["", " a ", "HTTPS://github.com/x", "git@github.com:x", "ssh://h/x", "/srv/x", "~/x", "./x", "file:///x"]) {
			expect(repoSearchQuery(text)).toBeNull();
		}
	});
});

describe("normalizeState", () => {
	it("repairs bad focus, widths and missing tiles", () => {
		const out = normalizeState({
			version: 1,
			activeWorkspaceId: "nope",
			workspaces: [
				{
					id: "w",
					name: "",
					mode: "tile",
					focusedId: "missing",
					tile: null,
					windows: [
						{ id: "a", kind: "terminal", title: "", width: 9, props: {} },
						{ id: "a", kind: "files", title: "", width: 0.5, props: { path: "/" } },
						{ id: "b", kind: "bogus", props: {} },
					],
				},
			],
		});
		expect(out?.activeWorkspaceId).toBe("w");
		const ws = out!.workspaces[0]!;
		expect(ws.windows.map((w) => w.id)).toEqual(["a"]);
		expect(ws.windows[0]!.width).toBe(1);
		expect(ws.focusedId).toBe("a");
		expect(ws.tile).toEqual({ type: "leaf", windowId: "a" });
		expect(ws.name).toBe("untitled");
		expect(normalizeState({ version: 2 })).toBeNull();
	});
});
