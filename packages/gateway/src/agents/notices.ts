import { isRecord } from "../util.ts";
import type { RpcFrame } from "./frames.ts";

/** Something an agent did that the user should hear about while away. */
export interface AgentNotice {
	kind: "input" | "done" | "error";
	text: string;
}

/** `extension_ui_request` methods besides `confirm` that wait for the user (see the gateway's `DIALOG_METHODS`). */
const QUESTION_METHODS: Record<string, true> = { select: true, input: true, editor: true, ask: true };
const MAX_TEXT = 240;

interface Reply {
	text: string;
	stopReason: string | null;
	error: string | null;
}

/**
 * Turns an agent's frame stream into notices: a dialog waiting for an answer, a finished turn (with the start of
 * the final reply), or a turn that ended in an error. Turns the user interrupted stay quiet.
 */
export class NoticeTracker {
	private reply: Reply | null = null;

	frame(frame: RpcFrame): AgentNotice | null {
		switch (frame.type) {
			case "agent_start":
				this.reply = null;
				return null;
			case "message_end": {
				const message = frame.message;
				if (isRecord(message) && message.role === "assistant") {
					this.reply = {
						text: replyText(message.content),
						stopReason: str(message.stopReason),
						error: str(message.errorMessage),
					};
				}
				return null;
			}
			case "agent_end": {
				// `yielded: false` means the agent keeps going (retry, compaction); older runtimes only send `isTerminal`.
				const yielded = typeof frame.yielded === "boolean" ? frame.yielded : frame.isTerminal !== false;
				if (!yielded) return null;
				const reply = this.reply;
				this.reply = null;
				if (reply?.stopReason === "aborted") return null;
				if (reply?.stopReason === "error") return { kind: "error", text: `Stopped: ${reply.error ?? "the model returned an error"}` };
				return { kind: "done", text: reply?.text ? `Finished: ${reply.text}` : "Finished." };
			}
			case "prompt_result": {
				if (frame.agentInvoked !== false || frame.status !== "error") return null;
				const error = isRecord(frame.error) ? str(frame.error.message) : str(frame.error);
				return { kind: "error", text: `Couldn't start: ${error ?? "the prompt failed"}` };
			}
			case "extension_ui_request":
				return dialogNotice(frame);
			default:
				return null;
		}
	}
}

/** The notice for OMP exiting while the gateway did not ask it to. */
export function exitNotice(code: number | null): AgentNotice {
	return { kind: "error", text: code === null ? "OMP stopped unexpectedly." : `OMP exited with code ${code}.` };
}

function dialogNotice(frame: RpcFrame): AgentNotice | null {
	const title = str(frame.title);
	if (frame.method === "confirm") {
		const message = str(frame.message);
		return { kind: "input", text: clip(`Needs approval: ${[title, message].filter(Boolean).join(": ") || "confirm to continue"}`) };
	}
	if (!Object.hasOwn(QUESTION_METHODS, String(frame.method))) return null;
	if (frame.method === "ask") {
		const questions = Array.isArray(frame.questions) ? frame.questions.filter(isRecord) : [];
		const first = str(questions[0]?.question) ?? str(questions[0]?.header);
		const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
		return { kind: "input", text: clip(`Asks: ${first ?? "a question"}${more}`) };
	}
	return { kind: "input", text: clip(`Asks: ${title ?? "for your input"}`) };
}

function replyText(content: unknown): string {
	if (typeof content === "string") return clip(content);
	if (!Array.isArray(content)) return "";
	const parts = content.flatMap((block) =>
		isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
	);
	return clip(parts.join(" "));
}

function clip(value: string): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1).trimEnd()}…` : flat;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
