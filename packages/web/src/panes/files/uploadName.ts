/** "Keep both" names for upload conflicts. */

/** `report.pdf` → `report (2).pdf`. Dotfiles and names without an extension take the suffix at the end. */
export function numberedName(name: string, n: number): string {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return `${name} (${n})`;
	return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

/** The first `numberedName(name, n)` with n ≥ `from` that is not in `taken`, and the n it used. */
export function keepBothName(name: string, taken: ReadonlySet<string>, from = 2): { name: string; n: number } {
	for (let n = from; ; n++) {
		const candidate = numberedName(name, n);
		if (!taken.has(candidate)) return { name: candidate, n };
	}
}
