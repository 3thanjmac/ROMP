/**
 * Plain-text snapshot of the xterm buffer for touch select mode: one text row per buffer row, so the selectable
 * layer lines up with the terminal, while copies join soft-wrapped rows back into their logical line.
 */
import type { IBuffer } from "@xterm/xterm";

export interface BufferText {
	text: string;
	/** Ascending offsets of the "\n" characters in `text` that only mark a soft wrap. */
	soft: number[];
}

export function snapshotBuffer(buffer: Pick<IBuffer, "length" | "getLine">): BufferText {
	const rows: string[] = [];
	const soft: number[] = [];
	let offset = 0;
	for (let i = 0; i < buffer.length; i++) {
		const wraps = i + 1 < buffer.length && !!buffer.getLine(i + 1)?.isWrapped;
		// A row that continues on the next keeps its trailing spaces: they are part of the logical line.
		const row = buffer.getLine(i)?.translateToString(!wraps) ?? "";
		rows.push(row);
		offset += row.length;
		if (wraps) soft.push(offset);
		offset += 1;
	}
	return { text: rows.join("\n"), soft };
}

/** The text between two offsets of `snap.text`, without the soft-wrap breaks. */
export function copyText(snap: BufferText, start: number, end: number): string {
	let out = "";
	let from = start;
	for (const at of snap.soft) {
		if (at < start) continue;
		if (at >= end) break;
		out += snap.text.slice(from, at);
		from = at + 1;
	}
	return out + snap.text.slice(from, end);
}

/** The run of non-whitespace around `offset` (a path, URL or word), or null on blank space. */
export function wordAt(text: string, offset: number): [number, number] | null {
	const isWord = (i: number) => i >= 0 && i < text.length && !/\s/.test(text[i] ?? " ");
	let at = offset;
	if (!isWord(at)) at -= 1;
	if (!isWord(at)) return null;
	let start = at;
	let end = at + 1;
	while (isWord(start - 1)) start--;
	while (isWord(end)) end++;
	return [start, end];
}
