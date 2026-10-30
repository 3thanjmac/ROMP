/**
 * Pure layout math for the window manager: scroll-mode width presets and strip moves, and the tile-mode
 * dwindle tree (build, insert, remove, reconcile, geometry, neighbours, split resizing).
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
/** Assumed container aspect (width / height) when none is known. */
const DEFAULT_ASPECT = 16 / 9;

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

/** Dwindle spiral: each window splits the space left by the previous one, alternating row and column. */
export function buildTile(ids: readonly string[], depth = 0): TileNode | null {
	const [first, ...rest] = ids;
	if (first === undefined) return null;
	const next = buildTile(rest, depth + 1);
	if (!next) return leaf(first);
	return { type: "split", dir: depth % 2 === 0 ? "row" : "column", ratio: 0.5, a: leaf(first), b: next };
}

/**
 * Inserts `id` by splitting the leaf `targetId` (or the last leaf when the target is absent). The split runs
 * side by side when the target is wider than tall (in px, given the container aspect), else stacked.
 */
export function insertLeaf(
	tree: TileNode | null,
	id: string,
	targetId: string | null,
	aspect = DEFAULT_ASPECT,
): TileNode {
	if (!tree) return leaf(id);
	const ids = leafIds(tree);
	const target = targetId && ids.includes(targetId) ? targetId : ids[ids.length - 1]!;
	const rect = tileRects(tree).get(target) ?? { x: 0, y: 0, w: 1, h: 1 };
	const dir = rect.w * aspect >= rect.h ? "row" : "column";
	const replace = (node: TileNode): TileNode => {
		if (node.type === "leaf") {
			return node.windowId === target ? { type: "split", dir, ratio: 0.5, a: node, b: leaf(id) } : node;
		}
		return { ...node, a: replace(node.a), b: replace(node.b) };
	};
	return replace(tree);
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

/** Makes the tree hold exactly `ids`: drops stale leaves (and duplicates), inserts missing ones next to `focusId`. */
export function reconcileTile(
	tree: TileNode | null,
	ids: readonly string[],
	focusId: string | null,
	aspect = DEFAULT_ASPECT,
): TileNode | null {
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
	let out = prune(tree);
	let anchor = focusId && seen.has(focusId) ? focusId : null;
	for (const id of ids) {
		if (seen.has(id)) continue;
		out = insertLeaf(out, id, anchor, aspect);
		seen.add(id);
		anchor = id;
	}
	return out;
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
