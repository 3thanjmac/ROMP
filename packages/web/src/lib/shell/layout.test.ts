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

describe("dwindle tree", () => {
	it("builds an alternating spiral covering the whole area", () => {
		const tree = buildTile(["a", "b", "c"]);
		expect(leafIds(tree)).toEqual(["a", "b", "c"]);
		const r = tileRects(tree);
		expect(r.get("a")).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
		expect(r.get("b")).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
		expect(r.get("c")).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
		const area = [...r.values()].reduce((s, x) => s + x.w * x.h, 0);
		expect(close(area, 1)).toBe(true);
	});

	it("splits along the longer side of the target in px", () => {
		const wide = insertLeaf({ type: "leaf", windowId: "a" }, "b", "a", 16 / 9);
		expect(wide.type === "split" && wide.dir).toBe("row");
		const tall = insertLeaf({ type: "leaf", windowId: "a" }, "b", "a", 9 / 16);
		expect(tall.type === "split" && tall.dir).toBe("column");
	});

	it("inserts next to the target and falls back to the last leaf", () => {
		const tree = buildTile(["a", "b"]);
		expect(leafIds(insertLeaf(tree, "x", "a"))).toEqual(["a", "x", "b"]);
		expect(leafIds(insertLeaf(tree, "x", "missing"))).toEqual(["a", "b", "x"]);
	});

	it("removes a leaf and promotes its sibling", () => {
		const tree = buildTile(["a", "b", "c"]);
		const out = removeLeaf(tree, "b");
		expect(leafIds(out)).toEqual(["a", "c"]);
		expect(removeLeaf({ type: "leaf", windowId: "a" }, "a")).toBeNull();
	});

	it("reconciles stale, duplicate and missing leaves", () => {
		const tree: TileNode = {
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
		const out = reconcileTile(tree, ["a", "c", "new"], "a");
		expect(leafIds(out).sort()).toEqual(["a", "c", "new"]);
		// The surviving split keeps the user's ratio.
		expect(out?.type === "split" && out.ratio).toBe(0.3);
	});

	it("lists splits with paths and sets ratios immutably", () => {
		const tree = buildTile(["a", "b", "c"])!;
		const splits = tileSplits(tree);
		expect(splits.map((s) => s.path)).toEqual(["", "b"]);
		expect(splits[1]!.rect).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
		const next = setRatioAt(tree, "b", 0.7);
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
		const down = resizeToward(tree, "b", "down");
		expect(tileSplits(down)[1]!.ratio).toBe(0.55);
		// No column split above "a": unchanged.
		expect(resizeToward(tree, "a", "down")).toBe(tree);
	});
});

describe("neighbor", () => {
	const rects = tileRects(buildTile(["a", "b", "c"]));
	it("finds panes by direction", () => {
		expect(neighbor(rects, "a", "right")).toBe("b");
		expect(neighbor(rects, "b", "down")).toBe("c");
		expect(neighbor(rects, "c", "left")).toBe("a");
		expect(neighbor(rects, "c", "up")).toBe("b");
		expect(neighbor(rects, "a", "left")).toBeNull();
	});
});
