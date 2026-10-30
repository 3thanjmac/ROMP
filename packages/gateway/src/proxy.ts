import type { Server } from "bun";
import { apiError, badRequest, forbidden } from "./http.ts";
import { errorMessage, withTimeout } from "./util.ts";
import type { Socket, WsData } from "./ws.ts";

export interface ProxyTarget {
	port: number;
	/** `/proxy/<port>` or `/absproxy/<port>`. */
	prefix: string;
	/** Path and query sent upstream. */
	upstreamPath: string;
}

export type ProxyRoute = { target: ProxyTarget } | { redirect: string } | null;

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

function upstreamHeaders(req: Request, target: ProxyTarget, publicUrl: URL): Headers {
	const headers = new Headers(req.headers);
	for (const name of [...HOP_BY_HOP, ...IDENTITY_HEADERS]) headers.delete(name);
	for (const name of [...headers.keys()]) if (name.startsWith("sec-websocket-")) headers.delete(name);
	// Dev servers commonly refuse unknown Host values (Vite's allowedHosts), so present the loopback name.
	headers.set("host", `127.0.0.1:${target.port}`);
	headers.set("x-forwarded-host", publicUrl.host);
	headers.set("x-forwarded-proto", publicUrl.protocol.replace(":", ""));
	if (target.prefix.startsWith("/proxy/")) headers.set("x-forwarded-prefix", target.prefix);
	return headers;
}

export function checkPort(target: ProxyTarget, ownPort: number): void {
	if (target.port === ownPort) throw forbidden("Refusing to proxy the gateway to itself");
}

export async function proxyHttp(req: Request, url: URL, target: ProxyTarget): Promise<Response> {
	let upstream: Response;
	try {
		upstream = await fetch(`http://127.0.0.1:${target.port}${target.upstreamPath}`, {
			method: req.method,
			headers: upstreamHeaders(req, target, url),
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
	server: Server<WsData>,
): Promise<Response | undefined> {
	const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean);
	const upstream = new WebSocket(`ws://127.0.0.1:${target.port}${target.upstreamPath}`, {
		protocols,
		headers: Object.fromEntries(upstreamHeaders(req, target, url)),
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
