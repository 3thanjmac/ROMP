import type { TileNode } from "@romp/protocol";
import { describe, expect, it } from "vitest";
import {
	buildTile,
	clampRatio,
	insertLeaf,
	leafIds,
	moveItem,
	neighbor,
	nextPreset,
	presetIndex,
	reconcileTile,
	removeLeaf,
	resizeToward,
	setRatioAt,
	swapLeaves,
	tileRects,
	tileSplits,
} from "./layout";

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

describe("width presets", () => {
	it("snaps foreign widths to the nearest preset", () => {
		expect(presetIndex(0.25)).toBe(0);
		expect(presetIndex(0.55)).toBe(1);
		expect(presetIndex(0.7)).toBe(2);
		expect(presetIndex(1)).toBe(3);
	});
	it("cycles and wraps from Full to One third", () => {
		expect(nextPreset(1 / 3)).toBe(1 / 2);
		expect(nextPreset(1)).toBe(1 / 3);
	});
});

describe("moveItem", () => {
	it("moves and clamps without mutating", () => {
		const list = ["a", "b", "c"];
		expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a"]);
		expect(moveItem(list, 2, -5)).toEqual(["c", "a", "b"]);
		expect(moveItem(list, 7, 0)).toEqual(list);
		expect(list).toEqual(["a", "b", "c"]);
	});
});

describe("grid tree", () => {
	const cells = (ids: string[]) => {
		const r = tileRects(buildTile(ids));
		return ids.map((id) => r.get(id));
	};

	it("stacks the first two windows top and bottom", () => {
		expect(cells(["a", "b"])).toEqual([
			{ x: 0, y: 0, w: 1, h: 0.5 },
			{ x: 0, y: 0.5, w: 1, h: 0.5 },
		]);
	});

	it("fills columns top to bottom before opening a new one", () => {
		expect(cells(["a", "b", "c"])).toEqual([
			{ x: 0, y: 0, w: 0.5, h: 0.5 },
			{ x: 0, y: 0.5, w: 0.5, h: 0.5 },
			{ x: 0.5, y: 0, w: 0.5, h: 1 },
		]);
		expect(cells(["a", "b", "c", "d"])).toEqual([
			{ x: 0, y: 0, w: 0.5, h: 0.5 },
			{ x: 0, y: 0.5, w: 0.5, h: 0.5 },
			{ x: 0.5, y: 0, w: 0.5, h: 0.5 },
			{ x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
		]);
	});

	it("keeps columns within one window of each other and cells equal per column", () => {
		for (let n = 1; n <= 16; n++) {
			const ids = Array.from({ length: n }, (_, i) => `w${i}`);
			const r = [...tileRects(buildTile(ids)).values()];
			expect(r).toHaveLength(n);
			expect(close(r.reduce((s, x) => s + x.w * x.h, 0), 1)).toBe(true);
			const byColumn = new Map<number, number[]>();
			for (const x of r) byColumn.set(Math.round(x.x * 1e6), [...(byColumn.get(Math.round(x.x * 1e6)) ?? []), x.h]);
			const counts = [...byColumn.values()].map((hs) => hs.length);
			expect(Math.max(...counts)).toBe(Math.ceil(Math.sqrt(n)));
			expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
			for (const hs of byColumn.values()) for (const h of hs) expect(close(h, 1 / hs.length)).toBe(true);
		}
		expect(cells(["a", "b", "c", "d", "e", "f", "g"]).map((r) => Math.round(r!.x * 3))).toEqual([0, 0, 0, 1, 1, 2, 2]);
	});

	it("inserts after the target, falls back to the last leaf, and re-lays the grid", () => {
		const tree = buildTile(["a", "b"]);
		const mid = insertLeaf(tree, "x", "a");
		expect(leafIds(mid)).toEqual(["a", "x", "b"]);
		expect(mid).toEqual(buildTile(["a", "x", "b"]));
		expect(leafIds(insertLeaf(tree, "x", "missing"))).toEqual(["a", "b", "x"]);
	});

	it("removes a leaf and promotes its sibling", () => {
		const tree = buildTile(["a", "b", "c"]);
		const out = removeLeaf(tree, "b");
		expect(leafIds(out)).toEqual(["a", "c"]);
		expect(removeLeaf({ type: "leaf", windowId: "a" }, "a")).toBeNull();
	});

	const custom: TileNode = {
		type: "split",
		dir: "row",
		ratio: 0.3,
		a: { type: "leaf", windowId: "a" },
		b: {
			type: "split",
			dir: "column",
			ratio: 0.5,
			a: { type: "leaf", windowId: "gone" },
			b: { type: "leaf", windowId: "c" },
		},
	};

	it("prunes stale and duplicate leaves without touching the user's ratios", () => {
		const out = reconcileTile(custom, ["a", "c"], "a");
		expect(leafIds(out)).toEqual(["a", "c"]);
		expect(out?.type === "split" && out.ratio).toBe(0.3);
	});

	it("re-lays a grid when windows are missing, placing them after the focus", () => {
		expect(reconcileTile(custom, ["a", "c", "new"], "a")).toEqual(buildTile(["a", "new", "c"]));
	});

	it("lists splits with paths and sets ratios immutably", () => {
		const tree = buildTile(["a", "b", "c"])!;
		const splits = tileSplits(tree);
		expect(splits.map((s) => s.path)).toEqual(["", "a"]);
		expect(splits[1]!.rect).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
		const next = setRatioAt(tree, "a", 0.7);
		expect(tileSplits(next)[1]!.ratio).toBe(0.7);
		expect(tileSplits(tree)[1]!.ratio).toBe(0.5);
	});

	it("swaps leaves", () => {
		expect(leafIds(swapLeaves(buildTile(["a", "b", "c"]), "a", "c"))).toEqual(["c", "b", "a"]);
	});
});

describe("ratios", () => {
	it("clamps to 0.15-0.85 and the 120px minimum", () => {
		expect(clampRatio(0.05)).toBe(0.15);
		expect(clampRatio(0.95)).toBe(0.85);
		expect(clampRatio(0.1, 400)).toBe(0.3);
		expect(clampRatio(0.9, 400)).toBe(0.7);
		expect(clampRatio(0.2, 200)).toBe(0.5);
	});

	it("resizes the nearest split across the requested axis", () => {
		const tree = buildTile(["a", "b", "c"]);
		const wider = resizeToward(tree, "a", "right");
		expect(wider?.type === "split" && wider.ratio).toBe(0.55);
		const down = resizeToward(tree, "a", "down");
		expect(tileSplits(down)[1]!.ratio).toBe(0.55);
		// No column split above "c": unchanged.
		expect(resizeToward(tree, "c", "down")).toBe(tree);
	});
});

describe("neighbor", () => {
	const rects = tileRects(buildTile(["a", "b", "c", "d"]));
	it("finds panes by direction", () => {
		expect(neighbor(rects, "a", "right")).toBe("c");
		expect(neighbor(rects, "a", "down")).toBe("b");
		expect(neighbor(rects, "d", "left")).toBe("b");
		expect(neighbor(rects, "d", "up")).toBe("c");
		expect(neighbor(rects, "a", "left")).toBeNull();
	});
});
