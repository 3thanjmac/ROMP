import type { Server } from "bun";
import { apiError, badRequest, forbidden } from "./http.ts";
import { stripSessionCookies } from "./sessions.ts";
import { errorMessage, withTimeout } from "./util.ts";
import type { TcpSocket } from "./procnet.ts";
import type { Socket, WsData } from "./ws.ts";

export interface ProxyTarget {
	port: number;
	/** `/proxy/<port>` or `/absproxy/<port>`. */
	prefix: string;
	/** Path and query sent upstream. */
	upstreamPath: string;
}

export type ProxyRoute = { target: ProxyTarget } | { redirect: string } | null;

export type LoopbackHost = "127.0.0.1" | "[::1]";

/**
 * The loopback address to dial for `port`. Dev servers bound to `localhost` listen on `::1` only
 * where the resolver returns IPv6 first (Vite on Debian), so 127.0.0.1 would be refused. An IPv4 or
 * wildcard listener answers on 127.0.0.1; nothing listening also yields 127.0.0.1 so the error names it.
 */
export function loopbackHost(port: number, listeners: readonly TcpSocket[]): LoopbackHost {
	let v6Loopback = false;
	for (const socket of listeners) {
		if (socket.localPort !== port || socket.scope === "other") continue;
		if (socket.family === 4 || socket.scope === "any") return "127.0.0.1";
		v6Loopback = true;
	}
	return v6Loopback ? "[::1]" : "127.0.0.1";
}

/**
 * Maps `/proxy/:port/*` (prefix stripped) and `/absproxy/:port/*` (path kept, for apps built with a
 * matching base) to a loopback port. `/proxy/:port` without a slash redirects so relative URLs resolve.
 */
export function parseProxyPath(pathname: string, search: string): ProxyRoute {
	const match = /^\/(proxy|absproxy)\/([^/]+)(\/.*)?$/.exec(pathname);
	if (!match) return null;
	const [, mode, portText = "", rest] = match;
	if (!/^[1-9]\d{0,4}$/.test(portText) || Number(portText) > 65535) throw badRequest(`Invalid port ${JSON.stringify(portText)}`);
	const prefix = `/${mode}/${portText}`;
	if (mode === "proxy") {
		if (rest === undefined) return { redirect: `${prefix}/${search}` };
		return { target: { port: Number(portText), prefix, upstreamPath: `${rest}${search}` } };
	}
	return { target: { port: Number(portText), prefix, upstreamPath: `${pathname}${search}` } };
}

/** Rewrites an upstream redirect so the browser stays behind the proxy prefix. */
export function rewriteLocation(location: string, target: ProxyTarget): string {
	const strip = target.prefix.startsWith("/proxy/");
	let path: string;
	if (location.startsWith("/") && !location.startsWith("//")) {
		path = location;
	} else {
		let url: URL;
		try {
			url = new URL(location);
		} catch {
			return location;
		}
		const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && Number(url.port || 80) === target.port;
		if (!local) return location;
		path = `${url.pathname}${url.search}${url.hash}`;
	}
	return strip || !path.startsWith(`${target.prefix}/`) ? `${strip ? target.prefix : ""}${path}` : path;
}

const HOP_BY_HOP = [
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
];
const IDENTITY_HEADERS = ["tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic"];

function upstreamHeaders(req: Request, target: ProxyTarget, host: LoopbackHost, publicUrl: URL): Headers {
	const headers = new Headers(req.headers);
	for (const name of [...HOP_BY_HOP, ...IDENTITY_HEADERS]) headers.delete(name);
	for (const name of [...headers.keys()]) if (name.startsWith("sec-websocket-")) headers.delete(name);
	// The ROMP session cookie authenticates to the gateway; a proxied dev server must never see it.
	const cookie = headers.get("cookie");
	if (cookie !== null) {
		const kept = stripSessionCookies(cookie);
		if (kept === null) headers.delete("cookie");
		else headers.set("cookie", kept);
	}
	// Dev servers commonly refuse unknown Host values (Vite's allowedHosts), so present the loopback address.
	headers.set("host", `${host}:${target.port}`);
	headers.set("x-forwarded-host", publicUrl.host);
	headers.set("x-forwarded-proto", publicUrl.protocol.replace(":", ""));
	if (target.prefix.startsWith("/proxy/")) headers.set("x-forwarded-prefix", target.prefix);
	return headers;
}

export function checkPort(target: ProxyTarget, ownPort: number): void {
	if (target.port === ownPort) throw forbidden("Refusing to proxy the gateway to itself");
}

/** Remembers the last `/proxy/<port>/` page loaded, for WebSockets that carry no Referer (Vite's HMR socket). */
export const PROXY_PORT_COOKIE = "romp-proxy-port";

function validPort(text: string | undefined): number | null {
	if (text === undefined || !/^[1-9]\d{0,4}$/.test(text)) return null;
	const port = Number(text);
	return port <= 65535 ? port : null;
}

/**
 * Dev servers write root-absolute URLs (`/@vite/client`, `/node_modules/…`, `href="/blog/"`) that escape the
 * `/proxy/<port>/` prefix. Such a request is attributed to the port of the same-origin page that made it,
 * named by its Referer, so the caller can redirect it back under the prefix.
 */
export function refererProxyPort(req: Request): number | null {
	const referer = req.headers.get("referer");
	if (referer === null) return null;
	let ref: URL;
	try {
		ref = new URL(referer);
	} catch {
		return null;
	}
	if (ref.host !== req.headers.get("host")?.toLowerCase()) return null;
	return validPort(/^\/proxy\/([^/]+)\//.exec(ref.pathname)?.[1]);
}

export function cookieProxyPort(req: Request): number | null {
	const cookie = req.headers.get("cookie");
	if (cookie === null) return null;
	for (const part of cookie.split(";")) {
		const [name, value] = part.trim().split("=", 2);
		if (name === PROXY_PORT_COOKIE) return validPort(value);
	}
	return null;
}

/** `/proxy/<port>` target for a root-absolute path attributed to `port`. */
export function prefixedTarget(port: number, url: URL): ProxyTarget {
	return { port, prefix: `/proxy/${port}`, upstreamPath: `${url.pathname}${url.search}` };
}

export async function proxyHttp(req: Request, url: URL, target: ProxyTarget, host: LoopbackHost): Promise<Response> {
	let upstream: Response;
	try {
		upstream = await fetch(`http://${host}:${target.port}${target.upstreamPath}`, {
			method: req.method,
			headers: upstreamHeaders(req, target, host, url),
			body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
			redirect: "manual",
			decompress: false,
			signal: req.signal,
		});
	} catch (err) {
		return apiError(502, "bad_gateway", `Nothing answered on port ${target.port}: ${errorMessage(err)}`);
	}
	const headers = new Headers(upstream.headers);
	for (const name of HOP_BY_HOP) headers.delete(name);
	const location = headers.get("location");
	if (location) headers.set("location", rewriteLocation(location, target));
	const dest = req.headers.get("sec-fetch-dest");
	if (target.prefix.startsWith("/proxy/") && (dest === "iframe" || dest === "document")) {
		headers.append("set-cookie", `${PROXY_PORT_COOKIE}=${target.port}; Path=/; Secure; HttpOnly; SameSite=Strict`);
	}
	return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

export interface ProxySocketData {
	kind: "proxy";
	upstream: WebSocket;
	/** Upstream messages that arrived before the client socket opened. */
	early: (string | ArrayBuffer)[];
	client: Socket | null;
	upstreamClosed: { code: number; reason: string } | null;
}

/**
 * Opens the upstream WebSocket first so the subprotocol it picked (e.g. Vite's `vite-hmr`) can be
 * echoed in the client handshake, then upgrades the client.
 */
export async function proxyWebSocket(
	req: Request,
	url: URL,
	target: ProxyTarget,
	host: LoopbackHost,
	server: Server<WsData>,
): Promise<Response | undefined> {
	const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean);
	const upstream = new WebSocket(`ws://${host}:${target.port}${target.upstreamPath}`, {
		protocols,
		headers: Object.fromEntries(upstreamHeaders(req, target, host, url)),
	});
	upstream.binaryType = "arraybuffer";
	const data: ProxySocketData = { kind: "proxy", upstream, early: [], client: null, upstreamClosed: null };
	const opened = Promise.withResolvers<void>();
	upstream.onopen = () => opened.resolve();
	upstream.onerror = () => opened.reject(new Error(`WebSocket to port ${target.port} failed`));
	upstream.onclose = () => opened.reject(new Error(`WebSocket to port ${target.port} closed during handshake`));
	try {
		await withTimeout(opened.promise, 10_000, `WebSocket to port ${target.port} timed out`);
	} catch (err) {
		upstream.close();
		return apiError(502, "bad_gateway", errorMessage(err));
	}
	upstream.onerror = null;
	upstream.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
		if (data.client) data.client.send(event.data);
		else data.early.push(event.data);
	};
	upstream.onclose = (event) => {
		data.upstreamClosed = { code: event.code, reason: event.reason };
		data.client?.close(sendableCloseCode(event.code), event.reason);
	};
	const headers = upstream.protocol ? { "sec-websocket-protocol": upstream.protocol } : undefined;
	if (server.upgrade(req, { data, headers })) return undefined;
	upstream.close();
	return apiError(400, "bad_request", "WebSocket upgrade failed");
}

export const proxySocket = {
	open(ws: Socket, data: ProxySocketData): void {
		data.client = ws;
		for (const message of data.early) ws.send(message);
		data.early = [];
		if (data.upstreamClosed) ws.close(sendableCloseCode(data.upstreamClosed.code), data.upstreamClosed.reason);
	},
	message(data: ProxySocketData, message: string | Buffer): void {
		if (data.upstream.readyState === WebSocket.OPEN) data.upstream.send(message as string | Uint8Array<ArrayBuffer>);
	},
	close(data: ProxySocketData, code: number, reason: string): void {
		data.client = null;
		if (data.upstream.readyState === WebSocket.OPEN || data.upstream.readyState === WebSocket.CONNECTING) {
			data.upstream.close(sendableCloseCode(code), reason);
		}
	},
};

/** Codes such as 1005/1006 describe a close but may not be sent in a close frame. */
export function sendableCloseCode(code: number): number {
	if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
	if (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) return code;
	return code === 1005 ? 1000 : 1011;
}
