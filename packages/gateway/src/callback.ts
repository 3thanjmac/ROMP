import type { CallbackResult } from "@romp/protocol";
import { HttpError, forbidden } from "./http.ts";
import type { TcpSocket } from "./procnet.ts";
import { loopbackHost } from "./proxy.ts";
import { errorMessage } from "./util.ts";

const TIMEOUT_MS = 10_000;
/** Enough of a callback page to find its message; the rest is cancelled. */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 300;

export interface CallbackTarget {
	/** Validated by `parseLoopbackCallback`. */
	url: URL;
	port: number;
}

export interface CallbackOptions {
	/** The gateway's own port: never a sign-in target. */
	ownPort: number;
	/** Only listeners owned by this uid are dialled, so the route can't reach other users' or system services. */
	uid: number;
	listeners: readonly TcpSocket[];
	timeoutMs?: number;
}

/**
 * Delivers an OAuth redirect (`http://localhost:<port>/callback?code=…`) to the program on the VM waiting for it,
 * as the browser would have had it run there. Redirects are reported, not followed.
 */
export async function deliverCallback(target: CallbackTarget, opts: CallbackOptions): Promise<CallbackResult> {
	const { url, port } = target;
	if (port === opts.ownPort) throw forbidden("That address is ROMP itself, not a sign-in waiting on the VM.");
	const owned = opts.listeners.filter((s) => s.localPort === port && s.uid === opts.uid && s.scope !== "other");
	if (owned.length === 0) {
		throw new HttpError(
			404,
			"nothing_listening",
			`Nothing on the VM is waiting on port ${port}. Start the sign-in again.`,
		);
	}
	const host = loopbackHost(port, owned);
	let res: Response;
	let body: string;
	try {
		res = await fetch(`http://${host}:${port}${url.pathname}${url.search}`, {
			redirect: "manual",
			headers: { host: url.host },
			signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
		});
		body = await readText(res, MAX_BODY_BYTES);
	} catch (err) {
		const reason = err instanceof DOMException && err.name === "TimeoutError" ? "it didn't answer in time" : errorMessage(err);
		throw new HttpError(502, "callback_failed", `Couldn't reach port ${port}: ${reason}`);
	}
	return { status: res.status, message: describe(res, body) };
}

function describe(res: Response, body: string): string {
	const text = pageText(body);
	if (text) return text;
	const location = res.headers.get("location");
	if (res.status >= 300 && res.status < 400 && location) {
		try {
			return `Redirected to ${new URL(location, "http://localhost").host}`;
		} catch {
			// Unparseable Location: fall through to the status line.
		}
	}
	return `${res.status} ${res.statusText}`.trim();
}

async function readText(res: Response, limit: number): Promise<string> {
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size < limit) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.byteLength;
		}
	} finally {
		void reader.cancel().catch(() => {});
	}
	return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Visible text of an HTML (or plain) page, whitespace collapsed, at most 300 characters. */
export function pageText(body: string): string {
	const text = body
		.replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (entity, name: string) => {
			if (name[0] !== "#") return Object.hasOwn(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()]! : entity;
			const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
		})
		.replace(/\s+/g, " ")
		.trim();
	return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1).trimEnd()}…` : text;
}
