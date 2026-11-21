/**
 * Pure layout math for the window manager: scroll-mode width presets and strip moves, and the tile-mode
 * grid tree (build, insert, remove, reconcile, geometry, neighbours, split resizing).
 * Rects are fractions (0..1) of the workspace area.
 */
import type { TileNode } from "@romp/protocol";

// ───────────── Scroll mode ─────────────

export const WIDTH_PRESETS = [1 / 3, 1 / 2, 2 / 3, 1] as const;
export const WIDTH_LABELS = ["One third", "Half", "Two thirds", "Full"] as const;
export const DEFAULT_WIDTH = 1 / 2;

/** Index of the preset closest to a stored width (stored widths may come from older or foreign clients). */
export function presetIndex(width: number): number {
	let best = 0;
	for (let i = 1; i < WIDTH_PRESETS.length; i++) {
		if (Math.abs(WIDTH_PRESETS[i]! - width) < Math.abs(WIDTH_PRESETS[best]! - width)) best = i;
	}
	return best;
}

/** The next preset after `width`, wrapping from Full back to One third. */
export function nextPreset(width: number): number {
	return WIDTH_PRESETS[(presetIndex(width) + 1) % WIDTH_PRESETS.length]!;
}

/** Moves the item at `from` to index `to` (clamped), returning a new array. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
	const out = list.slice();
	if (from < 0 || from >= out.length) return out;
	const [item] = out.splice(from, 1);
	out.splice(Math.max(0, Math.min(out.length, to)), 0, item!);
	return out;
}

// ───────────── Tile mode ─────────────

export type Dir = "left" | "right" | "up" | "down";

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface SplitInfo {
	/** Steps from the root ("a" = first child, "b" = second), e.g. "" for the root, "ba" for root.b.a. */
	path: string;
	dir: "row" | "column";
	ratio: number;
	/** The split node's own rect. */
	rect: Rect;
}

export const RATIO_MIN = 0.15;
export const RATIO_MAX = 0.85;
export const RATIO_STEP = 0.05;

/** Clamps a split ratio to 0.15–0.85 and, when the split's extent in px is known, to keep both sides ≥ minPx. */
export function clampRatio(ratio: number, extentPx?: number, minPx = 120): number {
	let lo = RATIO_MIN;
	let hi = RATIO_MAX;
	if (extentPx && extentPx > 0) {
		const minShare = minPx / extentPx;
		if (minShare < 0.5) {
			lo = Math.max(lo, minShare);
			hi = Math.min(hi, 1 - minShare);
		} else {
			lo = hi = 0.5;
		}
	}
	return Math.min(hi, Math.max(lo, ratio));
}

const leaf = (windowId: string): TileNode => ({ type: "leaf", windowId });

export function leafIds(node: TileNode | null): string[] {
	if (!node) return [];
	if (node.type === "leaf") return [node.windowId];
	return [...leafIds(node.a), ...leafIds(node.b)];
}

/** Lays `nodes` out evenly along `dir` as a balanced binary tree (ratios keep every part the same size). */
function evenSplit(nodes: TileNode[], dir: "row" | "column"): TileNode {
	if (nodes.length === 1) return nodes[0]!;
	const mid = Math.ceil(nodes.length / 2);
	return {
		type: "split",
		dir,
		ratio: mid / nodes.length,
		a: evenSplit(nodes.slice(0, mid), dir),
		b: evenSplit(nodes.slice(mid), dir),
	};
}

/**
 * Column-major grid: windows stack top to bottom before a new column opens, so two windows split into top
 * and bottom. Rows = ceil(√n); columns differ by at most one window, fuller columns first
 * (2 → 1 column of 2, 3 → 2+1, 4 → 2×2, 5 → 3+2, 7 → 3+2+2, 9 → 3×3).
 */
export function buildTile(ids: readonly string[]): TileNode | null {
	const n = ids.length;
	if (n === 0) return null;
	const rows = Math.ceil(Math.sqrt(n));
	const cols = Math.ceil(n / rows);
	const columns: TileNode[] = [];
	for (let c = 0, start = 0; c < cols; c++) {
		const size = Math.ceil((n - start) / (cols - c));
		columns.push(evenSplit(ids.slice(start, start + size).map(leaf), "column"));
		start += size;
	}
	return evenSplit(columns, "row");
}

/** Places `id` after `targetId` in leaf order (or last when the target is absent). */
function placeAfter(ids: string[], id: string, targetId: string | null): void {
	const at = targetId ? ids.indexOf(targetId) : -1;
	ids.splice(at >= 0 ? at + 1 : ids.length, 0, id);
}

/** Inserts `id` after the leaf `targetId` (or after the last leaf) and re-lays every window as an even grid. */
export function insertLeaf(tree: TileNode | null, id: string, targetId: string | null): TileNode {
	const ids = leafIds(tree).filter((x) => x !== id);
	placeAfter(ids, id, targetId);
	return buildTile(ids)!;
}

/** Removes a leaf; its sibling takes the parent's place. */
export function removeLeaf(tree: TileNode | null, id: string): TileNode | null {
	if (!tree) return null;
	if (tree.type === "leaf") return tree.windowId === id ? null : tree;
	const a = removeLeaf(tree.a, id);
	const b = removeLeaf(tree.b, id);
	if (!a) return b;
	if (!b) return a;
	return a === tree.a && b === tree.b ? tree : { ...tree, a, b };
}

/**
 * Makes the tree hold exactly `ids`: drops stale leaves (and duplicates), keeping the remaining splits and
 * ratios. Missing ids go in after `focusId` and the whole tree is re-laid as an even grid.
 */
export function reconcileTile(tree: TileNode | null, ids: readonly string[], focusId: string | null): TileNode | null {
	if (!tree) return buildTile(ids);
	const wanted = new Set(ids);
	const seen = new Set<string>();
	const prune = (node: TileNode): TileNode | null => {
		if (node.type === "leaf") {
			if (!wanted.has(node.windowId) || seen.has(node.windowId)) return null;
			seen.add(node.windowId);
			return node;
		}
		const a = prune(node.a);
		const b = prune(node.b);
		if (!a) return b;
		if (!b) return a;
		return a === node.a && b === node.b ? node : { ...node, a, b };
	};
	const out = prune(tree);
	const missing = ids.filter((id) => !seen.has(id));
	if (missing.length === 0) return out;
	const order = leafIds(out);
	let anchor = focusId && seen.has(focusId) ? focusId : null;
	for (const id of new Set(missing)) {
		placeAfter(order, id, anchor);
		anchor = id;
	}
	return buildTile(order);
}

export function tileRects(tree: TileNode | null): Map<string, Rect> {
	const out = new Map<string, Rect>();
	const walk = (node: TileNode, r: Rect) => {
		if (node.type === "leaf") {
			out.set(node.windowId, r);
			return;
		}
		const [ra, rb] = splitRect(node, r);
		walk(node.a, ra);
		walk(node.b, rb);
	};
	if (tree) walk(tree, { x: 0, y: 0, w: 1, h: 1 });
	return out;
}

function splitRect(node: Extract<TileNode, { type: "split" }>, r: Rect): [Rect, Rect] {
	if (node.dir === "row") {
		const wa = r.w * node.ratio;
		return [
			{ x: r.x, y: r.y, w: wa, h: r.h },
			{ x: r.x + wa, y: r.y, w: r.w - wa, h: r.h },
		];
	}
	const ha = r.h * node.ratio;
	return [
		{ x: r.x, y: r.y, w: r.w, h: ha },
		{ x: r.x, y: r.y + ha, w: r.w, h: r.h - ha },
	];
}

export function tileSplits(tree: TileNode | null): SplitInfo[] {
	const out: SplitInfo[] = [];
	const walk = (node: TileNode, r: Rect, path: string) => {
		if (node.type === "leaf") return;
		out.push({ path, dir: node.dir, ratio: node.ratio, rect: r });
		const [ra, rb] = splitRect(node, r);
		walk(node.a, ra, `${path}a`);
		walk(node.b, rb, `${path}b`);
	};
	if (tree) walk(tree, { x: 0, y: 0, w: 1, h: 1 }, "");
	return out;
}

/** Returns a copy of the tree with the split at `path` set to `ratio` (already clamped by the caller). */
export function setRatioAt(tree: TileNode, path: string, ratio: number): TileNode {
	if (tree.type === "leaf") return tree;
	if (path === "") return { ...tree, ratio };
	const [step, ...rest] = path;
	const tail = rest.join("");
	return step === "a" ? { ...tree, a: setRatioAt(tree.a, tail, ratio) } : { ...tree, b: setRatioAt(tree.b, tail, ratio) };
}

export function ratioAt(tree: TileNode | null, path: string): number | null {
	let node = tree;
	for (const step of path) {
		if (!node || node.type === "leaf") return null;
		node = step === "a" ? node.a : node.b;
	}
	return node && node.type === "split" ? node.ratio : null;
}

/** Path ("a"/"b" steps) from the root to the leaf holding `id`, or null. */
export function pathTo(tree: TileNode | null, id: string): string | null {
	if (!tree) return null;
	if (tree.type === "leaf") return tree.windowId === id ? "" : null;
	const a = pathTo(tree.a, id);
	if (a !== null) return `a${a}`;
	const b = pathTo(tree.b, id);
	return b === null ? null : `b${b}`;
}

/**
 * Moves the divider nearest to `id` that runs across `dir` (left/right → a row split, up/down → a column
 * split) by `step` toward `dir`. Returns the tree unchanged when no such split exists.
 */
export function resizeToward(tree: TileNode | null, id: string, dir: Dir, step = RATIO_STEP): TileNode | null {
	const path = pathTo(tree, id);
	if (!tree || path === null) return tree;
	const want = dir === "left" || dir === "right" ? "row" : "column";
	const sign = dir === "right" || dir === "down" ? 1 : -1;
	for (let len = path.length - 1; len >= 0; len--) {
		const at = path.slice(0, len);
		let node: TileNode = tree;
		for (const s of at) node = s === "a" ? (node as Extract<TileNode, { type: "split" }>).a : (node as Extract<TileNode, { type: "split" }>).b;
		if (node.type === "split" && node.dir === want) {
			return setRatioAt(tree, at, clampRatio(Math.round((node.ratio + sign * step) * 100) / 100));
		}
	}
	return tree;
}

/** Swaps two leaves' windows. */
export function swapLeaves(tree: TileNode | null, x: string, y: string): TileNode | null {
	if (!tree) return null;
	if (tree.type === "leaf") {
		if (tree.windowId === x) return leaf(y);
		if (tree.windowId === y) return leaf(x);
		return tree;
	}
	return { ...tree, a: swapLeaves(tree.a, x, y)!, b: swapLeaves(tree.b, x, y)! };
}

const EPS = 1e-6;

/** The pane adjacent to `fromId` in direction `dir`: nearest edge first, then most overlap, then closest centre. */
export function neighbor(rects: Map<string, Rect>, fromId: string, dir: Dir): string | null {
	const from = rects.get(fromId);
	if (!from) return null;
	let best: { id: string; gap: number; overlap: number; offset: number } | null = null;
	for (const [id, r] of rects) {
		if (id === fromId) continue;
		let gap: number;
		let overlap: number;
		let offset: number;
		if (dir === "left" || dir === "right") {
			gap = dir === "right" ? r.x - (from.x + from.w) : from.x - (r.x + r.w);
			overlap = Math.min(from.y + from.h, r.y + r.h) - Math.max(from.y, r.y);
			offset = Math.abs(r.y + r.h / 2 - (from.y + from.h / 2));
		} else {
			gap = dir === "down" ? r.y - (from.y + from.h) : from.y - (r.y + r.h);
			overlap = Math.min(from.x + from.w, r.x + r.w) - Math.max(from.x, r.x);
			offset = Math.abs(r.x + r.w / 2 - (from.x + from.w / 2));
		}
		if (gap < -EPS || overlap <= EPS) continue;
		const better =
			!best ||
			gap < best.gap - EPS ||
			(Math.abs(gap - best.gap) <= EPS &&
				(overlap > best.overlap + EPS || (Math.abs(overlap - best.overlap) <= EPS && offset < best.offset)));
		if (better) best = { id, gap, overlap, offset };
	}
	return best?.id ?? null;
}
