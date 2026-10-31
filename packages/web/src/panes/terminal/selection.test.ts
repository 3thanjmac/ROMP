import { describe, expect, it } from "vitest";
import { copyText, snapshotBuffer, wordAt } from "./selection";

/** Rows as xterm would hold them: fixed width, `wrapped` marks a soft-wrap continuation. */
function buffer(rows: Array<{ text: string; wrapped?: boolean }>) {
	return {
		length: rows.length,
		getLine: (i: number) => {
			const row = rows[i];
			if (!row) return undefined;
			return {
				isWrapped: !!row.wrapped,
				translateToString: (trimRight?: boolean) => (trimRight ? row.text.trimEnd() : row.text),
			} as never;
		},
	};
}

describe("snapshotBuffer / copyText", () => {
	const snap = snapshotBuffer(
		buffer([
			{ text: "$ echo hello  " },
			{ text: "git commit -m " },
			{ text: "fix wrapped   ", wrapped: true },
			{ text: "done          " },
		]),
	);

	it("lays out one row per buffer row, trimming rows that end a logical line", () => {
		expect(snap.text).toBe("$ echo hello\ngit commit -m \nfix wrapped\ndone");
	});

	it("joins soft-wrapped rows and keeps the space at the wrap point", () => {
		const start = snap.text.indexOf("git");
		const end = snap.text.indexOf("wrapped") + "wrapped".length;
		expect(copyText(snap, start, end)).toBe("git commit -m fix wrapped");
	});

	it("keeps hard line breaks", () => {
		expect(copyText(snap, 0, snap.text.length)).toBe("$ echo hello\ngit commit -m fix wrapped\ndone");
	});

	it("drops a soft break only when it falls inside the range", () => {
		const brk = snap.soft[0] ?? -1;
		expect(copyText(snap, brk + 1, brk + 4)).toBe("fix");
		expect(copyText(snap, brk - 3, brk)).toBe("-m ");
	});
});

describe("wordAt", () => {
	const text = "cd /srv/app && ls";

	it("selects the whole whitespace-delimited run under the offset", () => {
		expect(wordAt(text, 6)).toEqual([3, 11]);
	});

	it("takes the run that ends just before the offset", () => {
		expect(wordAt(text, 11)).toEqual([3, 11]);
		expect(wordAt(text, text.length)).toEqual([15, 17]);
	});

	it("returns null on blank space", () => {
		expect(wordAt("a   b", 2)).toBeNull();
	});
});
