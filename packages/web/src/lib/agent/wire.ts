/**
 * Defensive readers for OMP JSON. Frames reach the browser as `Record<string, unknown>`, so every field is checked
 * before use and unknown shapes degrade to "nothing to show" instead of throwing.
 */
import type { AskQuestion, UiRequest } from "./types";

export type Rec = Record<string, unknown>;

export function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function imageSrc(block: Rec): string | null {
	const data = str(block.data);
	const mime = str(block.mimeType);
	return data && mime ? `data:${mime};base64,${data}` : null;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Removes terminal escape sequences (colors, cursor moves, OSC titles) from command output. */
export function stripAnsi(text: string): string {
	return text.includes("\x1b") ? text.replace(ANSI, "") : text;
}

/** Text and images of a message or tool-result `content` (a string or an array of content blocks). */
export function readContent(content: unknown): { text: string; images: string[] } {
	if (typeof content === "string") return { text: content, images: [] };
	const parts: string[] = [];
	const images: string[] = [];
	if (Array.isArray(content)) {
		for (const block of content) {
			if (!isRec(block)) continue;
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
			else if (block.type === "image") {
				const src = imageSrc(block);
				if (src) images.push(src);
			}
		}
	}
	return { text: parts.join("\n"), images };
}

function askQuestions(value: unknown): AskQuestion[] | null {
	if (!Array.isArray(value)) return null;
	const questions: AskQuestion[] = [];
	for (const q of value) {
		if (!isRec(q) || typeof q.id !== "string" || typeof q.question !== "string" || !Array.isArray(q.options)) return null;
		const options = q.options.filter(isRec).flatMap(o =>
			typeof o.label === "string"
				? [{ label: o.label, description: str(o.description), preview: str(o.preview) }]
				: [],
		);
		questions.push({
			id: q.id,
			question: q.question,
			header: str(q.header),
			options,
			multi: q.multi === true,
			recommended: num(q.recommended),
		});
	}
	return questions;
}

/** A pending dialog from an `extension_ui_request`, or null for presentation methods and malformed frames. */
export function readUiRequest(frame: Rec, receivedAt: number): UiRequest | null {
	const id = str(frame.id);
	if (!id) return null;
	const base = { id, timeout: num(frame.timeout), receivedAt };
	const title = str(frame.title) ?? "";
	switch (frame.method) {
		case "select": {
			const details = Array.isArray(frame.optionDetails)
				? frame.optionDetails.map(d => ({ description: isRec(d) ? str(d.description) : undefined }))
				: undefined;
			return { ...base, method: "select", title, options: strings(frame.options), optionDetails: details };
		}
		case "confirm":
			return { ...base, method: "confirm", title, message: str(frame.message) ?? "" };
		case "input":
			return {
				...base,
				method: "input",
				title,
				placeholder: str(frame.placeholder),
				secret: frame.secret === true,
			};
		case "editor":
			return {
				...base,
				method: "editor",
				title,
				prefill: str(frame.prefill),
				promptStyle: frame.promptStyle === true,
			};
		case "ask": {
			const questions = askQuestions(frame.questions);
			return questions ? { ...base, method: "ask", questions } : null;
		}
		default:
			return null;
	}
}
