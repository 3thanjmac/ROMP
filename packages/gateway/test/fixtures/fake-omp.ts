// A minimal `omp --mode rpc` speaking the documented JSONL protocol, for exercising the gateway's Agent
// without a model. Sessions are JSON files under $FAKE_OMP_DIR.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_OMP_DIR ?? "/tmp";
let sessionFile = join(dir, `session-${process.pid}.json`);
let messages: unknown[] = [];
let busy = false;
let v2 = false;
let sessionName: string | undefined;

function emit(frame: object): void {
	const json = JSON.stringify(frame);
	if (!v2 || Buffer.byteLength(json) < 1024 * 1024) {
		process.stdout.write(`${json}\n`);
		return;
	}
	const bytes = Buffer.from(json);
	const size = 256 * 1024;
	const count = Math.ceil(bytes.length / size);
	for (let index = 0; index < count; index++) {
		const data = bytes.subarray(index * size, (index + 1) * size).toString("base64");
		process.stdout.write(`${JSON.stringify({ type: "rpc_chunk", chunkId: "c1", index, count, byteLength: bytes.length, data })}\n`);
	}
}

const respond = (cmd: Record<string, unknown>, data?: unknown, error?: string) =>
	emit({ type: "response", id: cmd.id, command: cmd.type, success: !error, ...(error ? { error } : { data }) });

function runTurn(text: string): void {
	busy = true;
	emit({ type: "agent_start" });
	const user = { role: "user", content: [{ type: "text", text }] };
	const reply = text === "big" ? "x".repeat(1_200_000) : `echo:${text}`;
	const assistant = { role: "assistant", content: [{ type: "text", text: reply }] };
	emit({ type: "message_update", messageId: "m1", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: reply.slice(0, 10) } });
	emit({ type: "message_end", message: assistant });
	messages.push(user, assistant);
	writeFileSync(sessionFile, JSON.stringify(messages));
	busy = false;
	emit({ type: "agent_end", messages: [], isTerminal: true, yielded: true });
}

emit({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 });

let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString();
	let newline: number;
	while ((newline = buffer.indexOf("\n")) >= 0) {
		const cmd = JSON.parse(buffer.slice(0, newline));
		buffer = buffer.slice(newline + 1);
		handle(cmd);
	}
});
process.stdin.on("end", () => process.exit(0));

function handle(cmd: Record<string, unknown>): void {
	switch (cmd.type) {
		case "negotiate_protocol":
			respond(cmd, { protocolVersion: 2 });
			v2 = true;
			return;
		case "set_event_filter":
		case "set_ask_dialog":
			respond(cmd, {});
			return;
		case "switch_session": {
			const path = String(cmd.sessionPath);
			if (!existsSync(path)) return respond(cmd, undefined, "no such session");
			sessionFile = path;
			messages = JSON.parse(readFileSync(path, "utf8"));
			return respond(cmd, { cancelled: false });
		}
		case "set_session_name":
			sessionName = String(cmd.name);
			return respond(cmd, {});
		case "get_state":
			return respond(cmd, { sessionFile, isStreaming: busy, sessionName });
		case "get_messages_page":
			return respond(cmd, { messages, totalMessages: messages.length });
		case "get_messages":
			return respond(cmd, { messages });
		case "prompt": {
			respond(cmd);
			const text = String(cmd.message);
			if (text === "ask") {
				emit({ type: "extension_ui_request", id: "ui1", method: "confirm", title: "Sure?" });
				return;
			}
			setTimeout(() => runTurn(text), 10);
			return;
		}
		case "extension_ui_response":
			emit({ type: "notice", text: `ui ${cmd.id} answered` });
			return;
		default:
			respond(cmd, undefined, `unknown command ${cmd.type}`);
	}
}
