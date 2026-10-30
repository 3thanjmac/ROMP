/**
 * Subsequence fuzzy match for the command palette. Returns null when `query` is not a subsequence of `text`
 * (case-insensitive); otherwise a score where higher is better: consecutive runs, matches at word starts and
 * an early first match all count.
 */
export function fuzzyScore(query: string, text: string): number | null {
	const q = query.trim().toLowerCase();
	if (!q) return 0;
	const t = text.toLowerCase();
	let score = 0;
	let ti = 0;
	let prev = -2;
	let first = -1;
	for (const ch of q) {
		if (ch === " ") continue;
		const found = t.indexOf(ch, ti);
		if (found < 0) return null;
		if (first < 0) first = found;
		const atWordStart = found === 0 || /[\s/._:-]/.test(t[found - 1]!);
		score += 1;
		if (found === prev + 1) score += 3;
		if (atWordStart) score += 2;
		prev = found;
		ti = found + 1;
	}
	if (t.startsWith(q)) score += 5;
	return score - first * 0.1;
}

/** Filters and orders `items` by fuzzy score on `key`; an empty query keeps the original order. */
export function fuzzyFilter<T>(items: readonly T[], query: string, key: (item: T) => string): T[] {
	if (!query.trim()) return items.slice();
	const scored: Array<{ item: T; score: number; i: number }> = [];
	items.forEach((item, i) => {
		const score = fuzzyScore(query, key(item));
		if (score !== null) scored.push({ item, score, i });
	});
	scored.sort((a, b) => b.score - a.score || a.i - b.i);
	return scored.map((s) => s.item);
}
