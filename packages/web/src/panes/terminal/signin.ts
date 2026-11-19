/**
 * Spots OAuth sign-ins started by CLIs in a terminal (wrangler, codex, vercel…): they print an authorization URL
 * whose `redirect_uri` points at a loopback port on the VM, which the user's browser (on another device) can't reach.
 */
import { parseLoopbackCallback } from "@romp/protocol";
import type { IBuffer } from "@xterm/xterm";

export interface SignInPrompt {
	/** The printed authorization URL; a new sign-in prints a new one (its `state` changes). */
	authUrl: string;
	/** Loopback port the CLI waits on. */
	port: number;
	/** Path of the callback, e.g. `/oauth/callback`. */
	path: string;
}

/** Up to whitespace, quotes, angle brackets, backticks or box-drawing borders that TUIs draw around text. */
const URL_PATTERN = /https?:\/\/[^\s"'<>`\u2500-\u257f]+/g;
const TRAILING_PUNCTUATION = /[).,;:!?\]]+$/;

/** The last sign-in prompt in `text`, or null. */
export function findSignInPrompt(text: string): SignInPrompt | null {
	let found: SignInPrompt | null = null;
	for (const match of text.matchAll(URL_PATTERN)) {
		const authUrl = match[0].replace(TRAILING_PUNCTUATION, "");
		let outer: URL;
		try {
			outer = new URL(authUrl);
		} catch {
			continue;
		}
		const redirect = outer.searchParams.get("redirect_uri");
		if (!redirect) continue;
		const target = parseLoopbackCallback(redirect) ?? parseLoopbackCallback(decodeOnce(redirect));
		if (target) found = { authUrl, port: target.port, path: target.url.pathname };
	}
	return found;
}

/** Some CLIs encode the redirect twice (`http%253A%252F%252F…`). */
function decodeOnce(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/**
 * The text of the last `rows` buffer rows, with wrapped rows joined back into one line. Rows xterm soft-wrapped
 * are joined, and so are full-width rows followed by a row that starts with text, which is how programs that
 * position the cursor themselves (full-screen TUIs) print a long URL.
 */
export function tailText(buffer: Pick<IBuffer, "length" | "getLine">, cols: number, rows: number): string {
	let start = Math.max(0, buffer.length - rows);
	// Begin at the start of a logical line.
	while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
	let out = "";
	for (let i = start; i < buffer.length; i++) {
		const next = buffer.getLine(i + 1);
		const soft = !!next?.isWrapped;
		const row = buffer.getLine(i)?.translateToString(!soft) ?? "";
		out += row;
		if (i + 1 >= buffer.length) break;
		const hard = !soft && row.length >= cols && /^\S/.test(next?.translateToString(true) ?? "");
		if (!soft && !hard) out += "\n";
	}
	return out;
}
