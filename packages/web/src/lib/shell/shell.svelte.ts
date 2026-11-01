/**
 * Window manager state and actions over ShellState (persisted by persist.svelte.ts). Panes reach it through
 * their PaneContext; chrome (bars, palette, overview, shortcuts) calls these actions directly.
 */
import type { ShellState, TileNode, WindowKind, WindowState, Workspace } from "@romp/protocol";
import { api, ApiFailure, errorMessage } from "../api";
import { basename, uid } from "../format";
import { toast } from "../ui/toast.svelte";
import {
	buildTile,
	DEFAULT_WIDTH,
	type Dir,
	insertLeaf,
	leafIds,
	moveItem,
	neighbor,
	nextPreset,
	reconcileTile,
	removeLeaf,
	resizeToward,
	setRatioAt,
	swapLeaves,
	tileRects,
} from "./layout";
import { paneStatuses, requestPaneFocus } from "./pane.svelte";
import type { NewWindow } from "./types";
import { viewport } from "./viewport.svelte";

export const DEFAULT_WIDTHS: Record<WindowKind, number> = {
	terminal: 1 / 2,
	agent: 1 / 2,
	files: 1 / 3,
	editor: 1 / 2,
	browser: 2 / 3,
	tasks: 1 / 2,
};

const NEW_WORKSPACE_NAME = "untitled";

/** The live session a window shows (terminal or agent), if it has one. */
export function sessionOf(win: WindowState): { kind: "terminal" | "agent"; id: string } | null {
	if (win.kind === "terminal" && win.props.termId) return { kind: "terminal", id: win.props.termId };
	if (win.kind === "agent" && win.props.agentId) return { kind: "agent", id: win.props.agentId };
	return null;
}

export const sessionKey = (s: { kind: string; id: string }) => `${s.kind}:${s.id}`;

/** The mode `ws` is laid out in. Phones always scroll; the stored mode is kept for larger screens. */
export function layoutMode(ws: Workspace): Workspace["mode"] {
	return viewport.layout === "phone" ? "scroll" : ws.mode;
}

async function endSession(session: { kind: "terminal" | "agent"; id: string }, title: string): Promise<void> {
	try {
		if (session.kind === "terminal") await api.terms.kill(session.id);
		else await api.agents.kill(session.id);
	} catch (err) {
		// Already gone: nothing to end.
		if (err instanceof ApiFailure && err.status === 404) return;
		toast({ message: `Couldn't end ${title}: ${errorMessage(err)}`, tone: "danger" });
	}
}

function newWorkspace(name: string): Workspace {
	return {
		id: uid(),
		name,
		mode: viewport.layout === "desktop" ? "tile" : "scroll",
		windows: [],
		focusedId: null,
		tile: null,
	};
}

/** First-run layout: one workspace with the Tasks window. */
export function seedState(): ShellState {
	const ws = newWorkspace("main");
	const tasks: WindowState = { id: uid(), kind: "tasks", title: "", width: DEFAULT_WIDTHS.tasks, props: {} };
	ws.windows.push(tasks);
	ws.focusedId = tasks.id;
	if (ws.mode === "tile") ws.tile = buildTile([tasks.id]);
	return { version: 1, activeWorkspaceId: ws.id, workspaces: [ws] };
}

/** Title shown everywhere for a window: user rename, then what the pane reports, then a kind-based fallback. */
export function displayTitle(win: WindowState): string {
	if (win.title) return win.title;
	const reported = paneStatuses.get(win.id)?.title;
	if (reported) return reported;
	switch (win.kind) {
		case "terminal":
			return win.props.cwd ? basename(win.props.cwd) : "Terminal";
		case "files":
			return basename(win.props.path) || "Files";
		case "editor":
			return basename(win.props.path) || "Editor";
		case "agent":
			return win.props.cwd ? basename(win.props.cwd) : "Agent";
		case "browser":
			return browserTitle(win.props.url);
		case "tasks":
			return win.props.repo ?? "Tasks";
	}
}

function browserTitle(url: string): string {
	const port = /^\/(?:abs)?proxy\/(\d+)\//.exec(url)?.[1];
	if (port) return `:${port}`;
	if (!url) return "Browser";
	try {
		return new URL(url, location.href).host || url;
	} catch {
		return url;
	}
}

/** Directory a new terminal/agent should start in when launched from `win`. */
export function windowCwd(win: WindowState | null): string | null {
	if (!win) return null;
	switch (win.kind) {
		case "terminal":
			return win.props.cwd ?? null;
		case "agent":
			return win.props.cwd;
		case "files":
			return win.props.path;
		case "editor": {
			const i = win.props.path.lastIndexOf("/");
			return i > 0 ? win.props.path.slice(0, i) : "/";
		}
		default:
			return null;
	}
}

export interface OpenOptions {
	/** Insert after this window (default: the focused one); in tile mode, split it. */
	after?: string | null;
	/** Focus the new window (default true). */
	focus?: boolean;
	/** Also move DOM focus into it (keyboard-initiated opens). */
	keyboard?: boolean;
}

interface Located {
	ws: Workspace;
	index: number;
	win: WindowState;
}

class Shell {
	state: ShellState = $state(seedState());
	/** Width / height of the workspace area; tile inserts split along the longer side. Set by Desk. */
	aspect = 16 / 9;
	/** Width each window had before "toggle full width". Not persisted. */
	#widthBeforeFull = new Map<string, number>();

	get active(): Workspace {
		const s = this.state;
		return s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? s.workspaces[0]!;
	}

	get focusedWindow(): WindowState | null {
		const ws = this.active;
		return ws.windows.find((w) => w.id === ws.focusedId) ?? null;
	}

	get activeIndex(): number {
		return this.state.workspaces.indexOf(this.active);
	}

	locate(id: string): Located | null {
		for (const ws of this.state.workspaces) {
			const index = ws.windows.findIndex((w) => w.id === id);
			if (index >= 0) return { ws, index, win: ws.windows[index]! };
		}
		return null;
	}

	/** First window (any workspace) matching `pred`. */
	find(pred: (win: WindowState) => boolean): WindowState | null {
		for (const ws of this.state.workspaces) {
			const win = ws.windows.find(pred);
			if (win) return win;
		}
		return null;
	}

	// ───────────── Windows ─────────────

	open(spec: NewWindow, opts: OpenOptions = {}): string {
		const ws = this.active;
		const win = {
			id: uid(),
			kind: spec.kind,
			title: spec.title ?? "",
			width: spec.width ?? DEFAULT_WIDTHS[spec.kind],
			props: spec.props,
		} as WindowState;
		const after = opts.after === undefined ? ws.focusedId : opts.after;
		const at = after ? ws.windows.findIndex((w) => w.id === after) : -1;
		ws.windows.splice(at >= 0 ? at + 1 : ws.windows.length, 0, win);
		if (ws.tile || ws.mode === "tile") {
			const synced = reconcileTile(ws.tile, ws.windows.filter((w) => w.id !== win.id).map((w) => w.id), ws.focusedId, this.aspect);
			ws.tile = insertLeaf(synced, win.id, at >= 0 ? after : null, this.aspect);
		}
		if (opts.focus !== false) {
			ws.focusedId = win.id;
			if (opts.keyboard) requestPaneFocus(win.id);
		} else if (!ws.focusedId) {
			ws.focusedId = win.id;
		}
		return win.id;
	}

	/**
	 * Closes a window with an Undo toast. The terminal or agent session it shows ends once the toast goes away
	 * without Undo (unless another window shows it by then).
	 */
	close(id: string): void {
		this.#detach(id, true);
	}

	/** Detaches a window with an Undo toast; its session keeps running and is listed under Running sessions. */
	minimize(id: string): void {
		this.#detach(id, false);
	}

	/** Sessions (sessionKey) of closed windows, waiting for their Undo toast to go away before they end. */
	readonly ending = new Set<string>();

	#detach(id: string, end: boolean): void {
		const loc = this.locate(id);
		if (!loc) return;
		const { ws, index } = loc;
		const title = displayTitle(loc.win);
		const saved = $state.snapshot(loc.win) as WindowState;
		const savedTile = ws.tile ? ($state.snapshot(ws.tile) as TileNode) : null;
		const session = end ? sessionOf(saved) : null;
		const key = session && sessionKey(session);
		if (key) this.ending.add(key);
		ws.windows.splice(index, 1);
		ws.tile = removeLeaf(ws.tile, id);
		if (ws.focusedId === id) ws.focusedId = (ws.windows[index] ?? ws.windows[index - 1])?.id ?? null;
		this.#widthBeforeFull.delete(id);
		toast({
			message: `${end ? "Closed" : "Minimized"} ${title}`,
			action: { label: "Undo", run: () => this.#restore(ws.id, index, saved, savedTile) },
			onclose: (reason) => {
				if (!session || !key) return;
				this.ending.delete(key);
				const shown = this.find((w) => {
					const s = sessionOf(w);
					return s !== null && sessionKey(s) === key;
				});
				if (reason !== "action" && !shown) void endSession(session, title);
			},
		});
	}

	#restore(wsId: string, index: number, win: WindowState, savedTile: TileNode | null): void {
		if (this.locate(win.id)) return;
		const ws = this.state.workspaces.find((w) => w.id === wsId) ?? this.active;
		ws.windows.splice(Math.min(index, ws.windows.length), 0, win);
		const ids = ws.windows.map((w) => w.id);
		const unchanged =
			savedTile !== null &&
			leafIds(savedTile).length === ids.length &&
			leafIds(savedTile).every((id) => ids.includes(id));
		if (unchanged) ws.tile = savedTile;
		else if (ws.tile || ws.mode === "tile") ws.tile = reconcileTile(ws.tile, ids, ws.focusedId, this.aspect);
		this.focus(win.id);
	}

	focus(id: string, opts: { keyboard?: boolean } = {}): void {
		const loc = this.locate(id);
		if (!loc) return;
		if (this.state.activeWorkspaceId !== loc.ws.id) this.#activate(loc.ws.id);
		loc.ws.focusedId = id;
		if (opts.keyboard) requestPaneFocus(id);
	}

	/** Focuses the window matching `pred` if one exists; returns whether it did. */
	focusWhere(pred: (win: WindowState) => boolean, opts: { keyboard?: boolean } = {}): boolean {
		const win = this.find(pred);
		if (!win) return false;
		this.focus(win.id, opts);
		return true;
	}

	focusDir(dir: Dir): void {
		const ws = this.active;
		const current = ws.focusedId;
		if (!current) {
			const first = ws.windows[0];
			if (first) this.focus(first.id, { keyboard: true });
			return;
		}
		let next: string | null = null;
		if (layoutMode(ws) === "tile") {
			next = neighbor(tileRects(ws.tile), current, dir);
		} else if (dir === "left" || dir === "right") {
			const i = ws.windows.findIndex((w) => w.id === current);
			next = ws.windows[i + (dir === "right" ? 1 : -1)]?.id ?? null;
		}
		if (next) this.focus(next, { keyboard: true });
	}

	/** Moves the focused window one place left/right (scroll: strip order; tile: swaps with its neighbour). */
	moveDir(dir: "left" | "right"): void {
		const ws = this.active;
		const id = ws.focusedId;
		if (!id) return;
		const i = ws.windows.findIndex((w) => w.id === id);
		if (layoutMode(ws) === "tile") {
			const other = neighbor(tileRects(ws.tile), id, dir);
			if (!other) return;
			ws.tile = swapLeaves(ws.tile, id, other);
			const j = ws.windows.findIndex((w) => w.id === other);
			if (i >= 0 && j >= 0) {
				const list = ws.windows.slice();
				[list[i], list[j]] = [list[j]!, list[i]!];
				ws.windows = list;
			}
		} else {
			const j = i + (dir === "right" ? 1 : -1);
			if (i < 0 || j < 0 || j >= ws.windows.length) return;
			ws.windows = moveItem(ws.windows, i, j);
		}
		requestPaneFocus(id);
	}

	/** Reorders a window within its workspace (Overview drag). */
	reorder(id: string, to: number): void {
		const loc = this.locate(id);
		if (!loc) return;
		loc.ws.windows = moveItem(loc.ws.windows, loc.index, to);
	}

	/** Moves a window to workspace number `n` (1-based); n = count + 1 creates a new workspace. */
	moveToWorkspace(id: string, n: number): void {
		const loc = this.locate(id);
		if (!loc) return;
		const count = this.state.workspaces.length;
		if (n < 1 || n > count + 1) return;
		const target = n === count + 1 ? this.#addWorkspace(NEW_WORKSPACE_NAME) : this.state.workspaces[n - 1]!;
		this.moveToWorkspaceId(id, target.id);
	}

	moveToWorkspaceId(id: string, wsId: string): void {
		const loc = this.locate(id);
		const target = this.state.workspaces.find((w) => w.id === wsId);
		if (!loc || !target || target === loc.ws) return;
		const { ws, index, win } = loc;
		ws.windows.splice(index, 1);
		ws.tile = removeLeaf(ws.tile, id);
		if (ws.focusedId === id) ws.focusedId = (ws.windows[index] ?? ws.windows[index - 1])?.id ?? null;
		target.windows.push(win);
		if (target.tile || target.mode === "tile") {
			target.tile = insertLeaf(
				reconcileTile(target.tile, target.windows.filter((w) => w.id !== id).map((w) => w.id), target.focusedId, this.aspect),
				id,
				target.focusedId,
				this.aspect,
			);
		}
		target.focusedId = id;
	}

	rename(id: string, title: string): void {
		const loc = this.locate(id);
		if (loc) loc.win.title = title.trim();
	}

	setProps(id: string, patch: Record<string, unknown>): void {
		const loc = this.locate(id);
		if (loc) Object.assign(loc.win.props, patch);
	}

	// ───────────── Widths (scroll mode) ─────────────

	setWidth(id: string, width: number): void {
		const loc = this.locate(id);
		if (!loc) return;
		loc.win.width = width;
		this.#widthBeforeFull.delete(id);
	}

	cycleWidth(id = this.active.focusedId): void {
		const loc = id ? this.locate(id) : null;
		if (loc) this.setWidth(loc.win.id, nextPreset(loc.win.width));
	}

	toggleFull(id = this.active.focusedId): void {
		const loc = id ? this.locate(id) : null;
		if (!loc) return;
		const { win } = loc;
		if (win.width >= 1) {
			win.width = this.#widthBeforeFull.get(win.id) ?? DEFAULT_WIDTHS[win.kind];
			this.#widthBeforeFull.delete(win.id);
		} else {
			this.#widthBeforeFull.set(win.id, win.width);
			win.width = 1;
		}
	}

	// ───────────── Modes and tiles ─────────────

	setMode(mode: Workspace["mode"], ws = this.active): void {
		if (mode === "tile") {
			ws.tile = reconcileTile(ws.tile, ws.windows.map((w) => w.id), ws.focusedId, this.aspect);
		}
		ws.mode = mode;
	}

	toggleMode(): void {
		this.setMode(this.active.mode === "scroll" ? "tile" : "scroll");
	}

	setRatio(path: string, ratio: number): void {
		const ws = this.active;
		if (ws.tile) ws.tile = setRatioAt(ws.tile, path, ratio);
	}

	resizeFocused(dir: Dir): void {
		const ws = this.active;
		if (layoutMode(ws) === "tile" && ws.focusedId) ws.tile = resizeToward(ws.tile, ws.focusedId, dir);
	}

	// ───────────── Workspaces ─────────────

	#addWorkspace(name: string): Workspace {
		this.state.workspaces.push(newWorkspace(name));
		return this.state.workspaces.at(-1)!;
	}

	addWorkspace(name = NEW_WORKSPACE_NAME): string {
		const ws = this.#addWorkspace(name.trim() || NEW_WORKSPACE_NAME);
		this.#activate(ws.id);
		return ws.id;
	}

	renameWorkspace(id: string, name: string): void {
		const ws = this.state.workspaces.find((w) => w.id === id);
		if (ws && name.trim()) ws.name = name.trim();
	}

	switchWorkspace(id: string): void {
		if (this.state.workspaces.some((w) => w.id === id)) this.#activate(id);
		const focused = this.active.focusedId;
		if (focused) requestPaneFocus(focused);
	}

	/** Workspace number `n` (1-based); n = count + 1 creates one. */
	switchToNumber(n: number): void {
		const count = this.state.workspaces.length;
		if (n >= 1 && n <= count) this.switchWorkspace(this.state.workspaces[n - 1]!.id);
		else if (n === count + 1) this.addWorkspace();
	}

	cycleWorkspace(delta: 1 | -1): void {
		const list = this.state.workspaces;
		const next = list[(this.activeIndex + delta + list.length) % list.length];
		if (next) this.switchWorkspace(next.id);
	}

	/** Switches the active workspace; an empty workspace being left is removed (at least one always remains). */
	#activate(id: string): void {
		const leaving = this.active;
		this.state.activeWorkspaceId = id;
		if (leaving.id !== id && leaving.windows.length === 0 && this.state.workspaces.length > 1) {
			const i = this.state.workspaces.indexOf(leaving);
			if (i >= 0) this.state.workspaces.splice(i, 1);
		}
	}
}

export const shell = new Shell();
