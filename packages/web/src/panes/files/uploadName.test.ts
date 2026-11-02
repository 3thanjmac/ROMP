import { describe, expect, it } from "vitest";
import { keepBothName, numberedName } from "./uploadName";

describe("numberedName", () => {
	it("puts the suffix before the extension", () => {
		expect(numberedName("report.pdf", 2)).toBe("report (2).pdf");
		expect(numberedName("archive.tar.gz", 3)).toBe("archive.tar (3).gz");
	});

	it("appends to dotfiles and names without an extension", () => {
		expect(numberedName(".env", 2)).toBe(".env (2)");
		expect(numberedName("Makefile", 2)).toBe("Makefile (2)");
	});
});

describe("keepBothName", () => {
	it("starts at 2", () => {
		expect(keepBothName("a.txt", new Set(["a.txt"]))).toEqual({ name: "a (2).txt", n: 2 });
	});

	it("skips taken names", () => {
		const taken = new Set(["a.txt", "a (2).txt", "a (3).txt"]);
		expect(keepBothName("a.txt", taken)).toEqual({ name: "a (4).txt", n: 4 });
	});

	it("advances from a given suffix", () => {
		expect(keepBothName("a.txt", new Set(), 5)).toEqual({ name: "a (5).txt", n: 5 });
	});
});
