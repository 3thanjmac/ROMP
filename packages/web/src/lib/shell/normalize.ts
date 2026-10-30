/**
 * Validates ShellState loaded from the gateway or localStorage (another client version, a hand edit or a
 * truncated write must never break the shell): drops malformed windows and duplicate ids, clamps widths,
 * repairs focus and the active workspace, and reconciles tile trees with the window list.
 */
import type { ShellState, TileNode, WindowState, Workspace } from "@romp/protocol";
import { buildTile, DEFAULT_WIDTH, reconcileTile } from "./layout";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const optString = (v: unknown) => v === undefined || typeof v === "string";

function validProps(kind: unknown, p: Obj): boolean {
	switch (kind) {
		case "terminal":
			return optString(p.termId) && optString(p.cwd);
		case "files":
		case "editor":
			return typeof p.path === "string";
		case "agent":
			return optString(p.agentId) && typeof p.cwd === "string";
		case "browser":
			return typeof p.url === "string";
		case "tasks":
			return optString(p.repo);
		default:
			return false;
	}
}

function toWindow(v: unknown): WindowState | null {
	if (!isObj(v) || typeof v.id !== "string" || !v.id || !isObj(v.props) || !validProps(v.kind, v.props)) return null;
	const width = typeof v.width === "number" && Number.isFinite(v.width) ? Math.min(1, Math.max(0.25, v.width)) : DEFAULT_WIDTH;
	return {
		id: v.id,
		kind: v.kind,
		title: typeof v.title === "string" ? v.title : "",
		width,
		props: v.props,
	} as WindowState;
}

function isTileNode(v: unknown): v is TileNode {
	if (!isObj(v)) return false;
	if (v.type === "leaf") return typeof v.windowId === "string";
	return (
		v.type === "split" &&
		(v.dir === "row" || v.dir === "column") &&
		typeof v.ratio === "number" &&
		v.ratio > 0 &&
		v.ratio < 1 &&
		isTileNode(v.a) &&
		isTileNode(v.b)
	);
}

export function normalizeState(raw: unknown): ShellState | null {
	if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.workspaces)) return null;
	const workspaceIds = new Set<string>();
	const windowIds = new Set<string>();
	const workspaces: Workspace[] = [];
	for (const w of raw.workspaces) {
		if (!isObj(w) || typeof w.id !== "string" || !w.id || workspaceIds.has(w.id)) continue;
		workspaceIds.add(w.id);
		const windows: WindowState[] = [];
		for (const candidate of Array.isArray(w.windows) ? w.windows : []) {
			const win = toWindow(candidate);
			if (!win || windowIds.has(win.id)) continue;
			windowIds.add(win.id);
			windows.push(win);
		}
		const ids = windows.map((x) => x.id);
		const mode = w.mode === "tile" ? "tile" : "scroll";
		const focusedId = typeof w.focusedId === "string" && ids.includes(w.focusedId) ? w.focusedId : (ids[0] ?? null);
		const tile = isTileNode(w.tile)
			? reconcileTile(w.tile, ids, focusedId)
			: mode === "tile"
				? buildTile(ids)
				: null;
		const name = typeof w.name === "string" && w.name.trim() ? w.name.trim() : "untitled";
		workspaces.push({ id: w.id, name, mode, windows, focusedId, tile });
	}
	const first = workspaces[0];
	if (!first) return null;
	const activeWorkspaceId =
		typeof raw.activeWorkspaceId === "string" && workspaceIds.has(raw.activeWorkspaceId)
			? raw.activeWorkspaceId
			: first.id;
	return { version: 1, activeWorkspaceId, workspaces };
}
