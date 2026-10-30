import type { ServerWebSocket } from "bun";
import type { Agent } from "./agents/agent.ts";
import type { ProxySocketData } from "./proxy.ts";
import type { TerminalSession } from "./terminals.ts";

export type WsData =
	| { kind: "term"; term: TerminalSession }
	| { kind: "agent"; agent: Agent }
	/** Accepted only to report why, since browsers cannot read a refused handshake's status. */
	| { kind: "reject"; code: number; reason: string }
	| ProxySocketData;
export type Socket = ServerWebSocket<WsData>;

/** Sends one JSON text frame, compressed when the client negotiated permessage-deflate. */
export function sendJson(ws: Socket, message: unknown): void {
	ws.send(JSON.stringify(message), true);
}
