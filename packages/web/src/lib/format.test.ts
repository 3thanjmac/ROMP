import { describe, expect, it } from "vitest";
import { approxPercent, resetsIn, windowName } from "./format";

describe("resetsIn", () => {
	const now = 1_000_000_000;
	const min = 60_000;
	it("formats each range", () => {
		expect(resetsIn(now + 30_000, now)).toBe("resets in <1m");
		expect(resetsIn(now + 14 * min, now)).toBe("resets in 14m");
		expect(resetsIn(now + (2 * 60 + 14) * min, now)).toBe("resets in 2h 14m");
		expect(resetsIn(now + (47 * 60 + 5) * min, now)).toBe("resets in 47h 5m");
		expect(resetsIn(now + (6 * 24 + 3) * 60 * min, now)).toBe("resets in 6d 3h");
	});
	it("reports a passed reset", () => {
		expect(resetsIn(now - min, now)).toBe("reset due; reopen to refresh");
		expect(resetsIn(now, now)).toBe("reset due; reopen to refresh");
	});
});

describe("approxPercent", () => {
	it("keeps one decimal below 10%", () => {
		expect(approxPercent(0.003)).toBe("≈0.3%");
		expect(approxPercent(0.03)).toBe("≈3%");
		expect(approxPercent(0.0951)).toBe("≈9.5%");
	});
	it("rounds from 10% up and at zero", () => {
		expect(approxPercent(0.427)).toBe("≈43%");
		expect(approxPercent(0)).toBe("≈0%");
	});
	it("never shows a nonzero share as 0", () => {
		expect(approxPercent(0.0001)).toBe("<0.1%");
	});
});

describe("windowName", () => {
	it("hyphenates window labels", () => {
		expect(windowName("5 Hour")).toBe("5-hour");
		expect(windowName("7 Day")).toBe("7-day");
	});
});
