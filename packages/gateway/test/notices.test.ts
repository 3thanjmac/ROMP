import { expect, test } from "bun:test";
import { NoticeTracker } from "../src/agents/notices.ts";
import type { RpcFrame } from "../src/agents/frames.ts";

const assistant = (extra: Record<string, unknown>): RpcFrame => ({ type: "message_end", message: { role: "assistant", ...extra } });
const end: RpcFrame = { type: "agent_end", messages: [], isTerminal: true, yielded: true };

function run(frames: RpcFrame[]) {
	const tracker = new NoticeTracker();
	return frames.flatMap((frame) => tracker.frame(frame) ?? []);
}

test("a finished turn reports the start of the final reply, not earlier tool-use messages", () => {
	const notices = run([
		{ type: "agent_start" },
		assistant({ content: [{ type: "text", text: "Let me check." }], stopReason: "toolUse" }),
		assistant({ content: [{ type: "text", text: "All tests\npass." }, { type: "text", text: "Done." }], stopReason: "stop" }),
		end,
	]);
	expect(notices).toEqual([{ kind: "done", text: "Finished: All tests pass. Done." }]);
});

test("an interrupted turn is silent, an errored one says why, and a continuing agent_end waits", () => {
	expect(run([{ type: "agent_start" }, assistant({ content: [], stopReason: "aborted", errorMessage: "Interrupted by user" }), end])).toEqual(
		[],
	);
	expect(
		run([
			{ type: "agent_start" },
			assistant({ content: [], stopReason: "error", errorMessage: "overloaded" }),
			{ type: "agent_end", isTerminal: true, yielded: false },
			assistant({ content: [], stopReason: "error", errorMessage: "rate limited" }),
			end,
		]),
	).toEqual([{ kind: "error", text: "Stopped: rate limited" }]);
});

test("a reply from the previous turn never leaks into the next one", () => {
	const tracker = new NoticeTracker();
	tracker.frame(assistant({ content: [{ type: "text", text: "old" }], stopReason: "stop" }));
	tracker.frame(end);
	tracker.frame({ type: "agent_start" });
	expect(tracker.frame(end)).toEqual({ kind: "done", text: "Finished." });
});

test("dialogs that wait for the user notify; presentation requests and cancels do not", () => {
	expect(
		run([
			{ type: "extension_ui_request", id: "1", method: "confirm", title: "Run bash?", message: "rm -rf build" },
			{ type: "extension_ui_request", id: "2", method: "ask", questions: [{ id: "q", question: "Which DB?" }, { id: "r", question: "Port?" }] },
			{ type: "extension_ui_request", id: "3", method: "select", title: "Pick a model" },
			{ type: "extension_ui_request", id: "4", method: "setWidget", widgetKey: "x" },
			{ type: "extension_ui_request", id: "5", method: "cancel", targetId: "1" },
		]),
	).toEqual([
		{ kind: "input", text: "Needs approval: Run bash?: rm -rf build" },
		{ kind: "input", text: "Asks: Which DB? (+1 more)" },
		{ kind: "input", text: "Asks: Pick a model" },
	]);
});

test("a prompt that failed before starting a turn is reported; one that ran is not", () => {
	expect(
		run([
			{ type: "prompt_result", agentInvoked: false, status: "error", error: { message: "No API key found for anthropic." } },
			{ type: "prompt_result", agentInvoked: true, status: "aborted" },
		]),
	).toEqual([{ kind: "error", text: "Couldn't start: No API key found for anthropic." }]);
});

test("long replies are clipped for the notification body", () => {
	const [notice] = run([assistant({ content: [{ type: "text", text: "word ".repeat(200) }], stopReason: "stop" }), end]);
	expect(notice?.text.length).toBeLessThanOrEqual(250);
	expect(notice?.text.endsWith("…")).toBe(true);
});
