/** Presentation of OMP tool calls: card icon kind, one-line summary, expanded argument/output text and diffs. */
import type { ToolBlock, ToolRun } from "./types";
import { isRec, str, stripAnsi } from "./wire";

export type ToolKind = "bash" | "edit" | "read" | "write" | "search" | "other";

export function toolKind(name: string): ToolKind {
	switch (name) {
		case "bash":
			return "bash";
		case "edit":
		case "ast_edit":
			return "edit";
		case "read":
			return "read";
		case "write":
			return "write";
		case "grep":
		case "find":
		case "glob":
		case "ast_grep":
			return "search";
		default:
			return "other";
	}
}

/**
 * Value of a top-level string field in a JSON object that may still be streaming (`toolcall_delta` fragments),
 * e.g. the `command` of `{"command": "sleep 2`. Returns undefined until the field's opening quote arrives.
 */
export function partialJsonString(json: string, key: string): string | undefined {
	const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
	if (!match) return undefined;
	let out = "";
	for (let i = match.index + match[0].length; i < json.length; i++) {
		const ch = json[i];
		if (ch === '"') return out;
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		const next = json[++i];
		if (next === undefined) break;
		if (next === "u") {
			const hex = json.slice(i + 1, i + 5);
			if (hex.length < 4) break;
			out += String.fromCharCode(Number.parseInt(hex, 16));
			i += 4;
		} else {
			out += { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" }[next] ?? next;
		}
	}
	return out;
}

function arg(block: ToolBlock, key: string): string | undefined {
	return str(block.args[key]) ?? partialJsonString(block.partialArgs, key);
}

/** Paths named by a hashline edit's `[path#TAG]` section headers. */
export function editPaths(input: string): string[] {
	return [...input.matchAll(/^\[(.+?)#[0-9A-Za-z]+\]$/gm)].flatMap(m => (m[1] ? [m[1]] : []));
}

/** One line for the card header: the command, path or pattern the call acts on. */
export function toolSummary(block: ToolBlock): string {
	const a = block.args;
	let summary: string | undefined;
	switch (block.name) {
		case "bash":
			summary = arg(block, "command");
			break;
		case "read":
		case "write":
			summary = arg(block, "path");
			break;
		case "edit": {
			const paths = editPaths(arg(block, "input") ?? "");
			summary = paths.length > 0 ? paths.join(", ") : arg(block, "path");
			break;
		}
		case "grep": {
			const pattern = arg(block, "pattern");
			const path = str(a.path);
			summary = pattern && path ? `${pattern} in ${path}` : pattern;
			break;
		}
		case "find":
		case "glob":
			summary = arg(block, "pattern") ?? arg(block, "path");
			break;
		case "web_search":
			summary = arg(block, "query");
			break;
		case "eval":
		case "python":
			summary = arg(block, "code");
			break;
		case "ask": {
			const first = Array.isArray(a.questions) ? a.questions[0] : undefined;
			summary = isRec(first) ? str(first.question) : undefined;
			break;
		}
	}
	return (summary ?? block.intent ?? "").split("\n", 1)[0] ?? "";
}

/** Arguments for the expanded card, without OMP's `i` (intent) field. */
export function toolArgsText(block: ToolBlock): string {
	switch (block.name) {
		case "bash":
			return arg(block, "command") ?? "";
		case "eval":
		case "python":
			return arg(block, "code") ?? "";
		case "write":
			return arg(block, "content") ?? "";
		case "edit":
			return arg(block, "input") ?? "";
		case "ask":
			return "";
	}
	const { i: _intent, ...rest } = block.args;
	const keys = Object.keys(rest);
	if (keys.length === 0) return block.partialArgs;
	// A lone path is already the header summary.
	if (keys.length === 1 && keys[0] === "path") return "";
	return JSON.stringify(rest, null, 2);
}

/** Output for the expanded card; `read` results drop their hashline anchors when OMP provides display text. */
export function toolOutputText(name: string, run: ToolRun): string {
	if (name === "read" && run.status === "done" && isRec(run.details?.displayContent)) {
		const text = str(run.details.displayContent.text);
		if (text !== undefined) return text;
	}
	return stripAnsi(run.output);
}

export interface DiffLine {
	kind: "add" | "del" | "ctx" | "gap";
	/** Line number for the gutter; empty when absent or repeated from the previous row. */
	num: string;
	text: string;
}

/**
 * Parses OMP's diff text: canonical `+12|text`, legacy `+12 text`, unified `+text` / `@@ … @@`, and gap rows.
 * A `+N` right after `-N` (single-line replacement) gets an empty gutter, as in the terminal UI.
 */
export function parseDiff(diff: string): DiffLine[] {
	let prevNum = "";
	return diff.split("\n").map(line => {
		const m = /^([+\- ])(\s*\d+)\|(.*)$/.exec(line) ?? /^([+\- ])(?:(\s*\d+)\s)?(.*)$/.exec(line);
		const trimmed = line.trim();
		if (!m || trimmed === "" || trimmed === "..." || trimmed === "…") {
			prevNum = "";
			return { kind: "gap", num: "", text: trimmed === "" || trimmed === "..." ? "…" : line };
		}
		const num = m[2]?.trim() ?? "";
		const shown = num !== "" && num === prevNum ? "" : num;
		prevNum = num;
		return { kind: m[1] === "+" ? "add" : m[1] === "-" ? "del" : "ctx", num: shown, text: m[3] ?? "" };
	});
}
