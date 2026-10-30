import type { AgentInfo, AgentServerMsg } from "@romp/protocol";
import { describe, expect, it } from "vitest";
import bashAbort from "./fixtures/bash-abort.jsonl?raw";
import bashRun from "./fixtures/bash-run.jsonl?raw";
import bashRunSnapshot from "./fixtures/bash-run.snapshot.jsonl?raw";
import promptError from "./fixtures/prompt-error.jsonl?raw";
import { emptyView, type Input, reduce, type Step } from "./reducer";
import { toolSummary } from "./tools";
import type { AgentView, AssistantItem, Effect, ToolBlock } from "./types";

const NOW = 1793241000000;

function parseJsonl(jsonl: string): Input[] {
	return jsonl
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as Input);
}

/** Folds inputs one by one, each 100ms after the previous, collecting every effect. */
function run(inputs: Input[], from: AgentView = emptyView()): { view: AgentView; effects: Effect[]; views: AgentView[] } {
	let view = from;
	const effects: Effect[] = [];
	const views: AgentView[] = [];
	inputs.forEach((input, i) => {
		const step: Step = reduce(view, input, NOW + i * 100);
		view = step.view;
		effects.push(...step.effects);
		views.push(view);
	});
	return { view, effects, views };
}

const info: AgentInfo = {
	id: "a1",
	title: "romp-fix",
	cwd: "/tmp/romp-fix",
	createdAt: NOW,
	busy: false,
	clients: 1,
	exited: false,
	exitCode: null,
	task: null,
};

function snapshot(messages: unknown[], opts: { busy?: boolean; queued?: { steering: string[]; followUp: string[] } } = {}): AgentServerMsg {
	return {
		t: "snapshot",
		info: { ...info, busy: opts.busy ?? false },
		messages,
		state: { isStreaming: opts.busy ?? false, queuedMessages: opts.queued ?? { steering: [], followUp: [] } },
		pendingUi: [],
	};
}

const frame = (f: Record<string, unknown> & { type: string }): Input => ({ t: "frame", frame: f });

function assistant(view: AgentView, n: number): AssistantItem {
	const item = view.items.filter(i => i.kind === "assistant")[n];
	if (item?.kind !== "assistant") throw new Error(`no assistant item ${n}`);
	return item;
}

/** Index of the nth input matching `pred`. */
function find(inputs: Input[], pred: (i: Input) => boolean, nth = 0): number {
	let seen = -1;
	const index = inputs.findIndex(i => pred(i) && ++seen === nth);
	if (index < 0) throw new Error("no matching input");
	return index;
}

const isFrame = (type: string, has?: string) => (i: Input) =>
	i.t === "frame" && i.frame.type === type && (has === undefined || JSON.stringify(i.frame).includes(has));

describe("live bash run (captured from the gateway)", () => {
	const inputs = parseJsonl(bashRun);
	const { view, views, effects } = run(inputs);
	const at = (type: string, nth = 0) => views[find(inputs, isFrame(type), nth)]!;
	const callId = (assistant(view, 0).blocks[0] as ToolBlock).id;

	it("summarizes the tool call from partial argument JSON while it streams", () => {
		const block = assistant(views[find(inputs, isFrame("message_update", 'echo hello-"'))]!, 0).blocks[0] as ToolBlock;
		expect(block).toMatchObject({ type: "tool", name: "bash", args: {} });
		expect(toolSummary(block)).toBe("echo hello-");
		const done = assistant(at("message_end", 1), 0).blocks[0] as ToolBlock;
		expect(done.args).toMatchObject({ command: "echo hello-romp" });
	});

	it("tracks the tool run from start to end", () => {
		expect(at("tool_execution_start").tools[callId]).toMatchObject({ status: "running", output: "" });
		expect(at("tool_execution_update").tools[callId]).toMatchObject({ status: "running", output: "hello-romp\n" });
		expect(at("tool_execution_end").tools[callId]).toMatchObject({ status: "done", output: "hello-romp\n" });
		// The toolResult message that follows never replaces the finished run.
		expect(view.tools[callId]).toBe(at("tool_execution_end").tools[callId]);
	});

	it("streams text deltas into the open block", () => {
		const mid = assistant(views[find(inputs, isFrame("message_update", "text_delta"), 1)]!, 1);
		expect(mid).toMatchObject({ streaming: true, openBlock: 0, blocks: [{ type: "text", text: "The bash command ran once" }] });
	});

	it("shows the optimistic message until the transcript has it", () => {
		const sent = find(inputs, i => i.t === "sent");
		expect(views[sent]!.outbox).toMatchObject([{ reqId: "r1", kind: "prompt", acked: false }]);
		expect(views[sent + 1]!.outbox).toMatchObject([{ acked: true }]);
		expect(at("agent_start").busy).toBe(true);
		expect(at("message_start").outbox).toEqual([]);
	});

	it("ends idle with the transcript and nothing pending", () => {
		expect(view.items.map(i => i.kind)).toEqual(["user", "assistant", "assistant"]);
		expect(assistant(view, 1)).toMatchObject({
			streaming: false,
			stopReason: "stop",
			blocks: [{ type: "text", text: "The bash command ran once and printed `hello-romp`." }],
		});
		expect(view).toMatchObject({ busy: false, busySince: null, outbox: [], pendingUi: [] });
		expect(effects).toEqual([]);
	});

	it("yields the same transcript from the snapshot a reloading tab gets", () => {
		const reloaded = run(parseJsonl(bashRunSnapshot)).view;
		expect(reloaded.items.map(i => (i.kind === "assistant" ? i.blocks : i.kind === "user" ? i.text : i.kind))).toEqual(
			view.items.map(i => (i.kind === "assistant" ? i.blocks : i.kind === "user" ? i.text : i.kind)),
		);
		expect(reloaded.tools[callId]).toMatchObject({ status: "done", output: "hello-romp\n" });
		expect(reloaded.busy).toBe(false);
	});
});

describe("thinking deltas", () => {
	it("rebuilds thinking from deltas and times it", () => {
		const upd = (event: Record<string, unknown>): Input =>
			frame({ type: "message_update", messageId: "m1", message: { role: "assistant" }, assistantMessageEvent: event });
		const { views } = run([
			snapshot([]),
			frame({ type: "message_start", messageId: "m1", message: { role: "assistant", content: [] } }),
			upd({ type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "" } }),
			upd({ type: "thinking_delta", contentIndex: 0, delta: "Need to" }),
			upd({ type: "thinking_delta", contentIndex: 0, delta: " run echo." }),
			upd({ type: "thinking_end", contentIndex: 0, content: "Need to run echo." }),
			frame({
				type: "message_end",
				messageId: "m1",
				message: { role: "assistant", content: [{ type: "thinking", thinking: "Need to run echo." }], stopReason: "stop" },
			}),
		]);
		expect(assistant(views[4]!, 0)).toMatchObject({ openBlock: 0, blocks: [{ type: "thinking", text: "Need to run echo.", endedAt: null }] });
		const done = assistant(views[6]!, 0).blocks[0];
		expect(done).toMatchObject({ type: "thinking", startedAt: NOW + 200, endedAt: NOW + 500 });
	});
});

describe("snapshots", () => {
	const captured = parseJsonl(bashRunSnapshot)[0];
	if (captured?.t !== "snapshot") throw new Error("fixture is not a snapshot");
	const messages = captured.messages;

	it("marks a call without a result as running mid-run and interrupted otherwise", () => {
		const cut = messages.slice(0, 2);
		const id = (assistant(run([snapshot(cut)]).view, 0).blocks[0] as ToolBlock).id;
		expect(run([snapshot(cut, { busy: true })]).view.tools[id]?.status).toBe("running");
		expect(run([snapshot(cut)]).view.tools[id]?.status).toBe("interrupted");
	});

	it("gives an unconfirmed send from a dropped connection back to the composer", () => {
		const { view, effects } = run([
			snapshot([]),
			{ t: "sent", reqId: "r1", kind: "prompt", text: "lost one" },
			{ t: "connected" },
			snapshot([]),
		]);
		expect(view.outbox).toEqual([]);
		expect(effects[0]).toEqual({ type: "restore", text: "lost one" });
		expect(effects[1]?.type).toBe("toast");
	});

	it("keeps sends that the snapshot already shows, and sends on the live connection", () => {
		const { view, effects } = run([
			snapshot([]),
			{ t: "sent", reqId: "r1", kind: "steer", text: "use tabs" },
			{ t: "connected" },
			{ t: "sent", reqId: "r2", kind: "prompt", text: "after respawn" },
			snapshot([], { queued: { steering: ["use tabs"], followUp: [] } }),
		]);
		expect(effects).toEqual([]);
		expect(view.queue.steering).toEqual(["use tabs"]);
		expect(view.outbox).toMatchObject([{ reqId: "r2", orphan: false }]);
	});
});

describe("send failures", () => {
	it("puts a rejected prompt back (captured: missing credentials)", () => {
		const { view, effects } = run(parseJsonl(promptError));
		expect(view.outbox).toEqual([]);
		expect(effects).toContainEqual({ type: "restore", text: "Use the bash tool once to run exactly: echo hello-romp." });
		expect(effects.filter(e => e.type === "toast").map(e => e.type === "toast" && e.tone)).toEqual(["neutral", "danger"]);
		expect(view.items).toEqual([]);
	});

	it("drops a prompt that an extension finished without a turn", () => {
		const { view } = run([
			snapshot([]),
			{ t: "sent", reqId: "r1", kind: "prompt", text: "/status" },
			{ t: "response", reqId: "r1", success: true },
			frame({ type: "prompt_result", id: "x", agentInvoked: false, status: "completed", sessionSettled: true }),
		]);
		expect(view.outbox).toEqual([]);
	});

	it("moves a steer from the outbox to the queue, then into the transcript", () => {
		const user = { role: "user", content: "use tabs", steering: true, timestamp: NOW };
		const { views } = run([
			snapshot([], { busy: true }),
			{ t: "sent", reqId: "r1", kind: "steer", text: "use tabs" },
			{ t: "response", reqId: "r1", success: true },
			frame({ type: "queue_update", steering: ["use tabs"], followUp: [] }),
			frame({ type: "message_start", messageId: "m9", message: user }),
			frame({ type: "queue_update", steering: [], followUp: [] }),
		]);
		expect(views[3]).toMatchObject({ outbox: [], queue: { steering: ["use tabs"] } });
		expect(views[5]?.items.at(-1)).toMatchObject({ kind: "user", text: "use tabs", steering: true });
		expect(views[5]?.queue.steering).toEqual([]);
	});
});

describe("abort", () => {
	it("ends a live run aborted mid-command (captured from the gateway)", () => {
		const inputs = parseJsonl(bashAbort);
		const { view, views, effects } = run(inputs);
		const id = (assistant(view, 0).blocks[0] as ToolBlock).id;
		const ended = views[find(inputs, isFrame("tool_execution_end"))]!;
		expect(ended.tools[id]).toMatchObject({ status: "error", output: "Command aborted" });
		// OMP sends one more update after the end; it must not reopen the card.
		expect(view.tools[id]).toBe(ended.tools[id]);
		expect(assistant(view, 1)).toMatchObject({ blocks: [], stopReason: "aborted", streaming: false });
		expect(view).toMatchObject({ busy: false, outbox: [] });
		expect(effects).toEqual([]);
	});

	it("marks a call still running when the run yields as interrupted", () => {
		const call = { type: "toolCall", id: "tc9", name: "bash", arguments: { command: "sleep 20" } };
		const aborted = { role: "assistant", content: [call], stopReason: "toolUse", timestamp: NOW };
		const { view } = run([
			snapshot([]),
			frame({ type: "agent_start" }),
			frame({ type: "message_start", messageId: "m1", message: { role: "assistant", content: [] } }),
			frame({ type: "message_end", messageId: "m1", message: aborted }),
			frame({ type: "tool_execution_start", toolCallId: "tc9", toolName: "bash", args: call.arguments }),
			frame({ type: "agent_end", messages: [], isTerminal: true, yielded: true }),
			// A late cancellation notice must not reopen it.
			frame({ type: "tool_execution_update", toolCallId: "tc9", partialResult: { content: [{ type: "text", text: "x" }] } }),
		]);
		expect(view.busy).toBe(false);
		expect(view.tools.tc9?.status).toBe("interrupted");
		expect(view.tools.tc9?.output).toBe("");
	});

	it("keeps working through a non-yielding agent_end", () => {
		const { view } = run([
			snapshot([]),
			frame({ type: "agent_start" }),
			frame({ type: "agent_end", messages: [], isTerminal: false, yielded: false }),
		]);
		expect(view.busy).toBe(true);
	});
});

describe("extension dialogs", () => {
	const ask = frame({ type: "extension_ui_request", id: "ui1", method: "confirm", title: "Delete?", message: "Sure?", timeout: 30000 });

	it("queues dialog requests and drops them when any client answers", () => {
		const { views } = run([snapshot([]), ask, frame({ type: "extension_ui_response", id: "ui1", confirmed: true })]);
		expect(views[1]?.pendingUi).toMatchObject([{ id: "ui1", method: "confirm", title: "Delete?", timeout: 30000 }]);
		expect(views[2]?.pendingUi).toEqual([]);
	});

	it("drops a dialog OMP cancelled", () => {
		const { view } = run([snapshot([]), ask, frame({ type: "extension_ui_request", id: "ui2", method: "cancel", targetId: "ui1" })]);
		expect(view.pendingUi).toEqual([]);
	});

	it("keeps presentation methods out of the dialog list", () => {
		const { view } = run([
			snapshot([]),
			frame({ type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "romp", statusText: "Queued" }),
			frame({ type: "extension_ui_request", id: "w1", method: "setWidget", widgetKey: "autoresearch" }),
		]);
		expect(view.pendingUi).toEqual([]);
		expect(view.statuses).toEqual({ romp: "Queued" });
		expect(view.widgets).toEqual({});
	});
});

describe("process exit", () => {
	it("settles the run and clears dialogs, then a respawn snapshot reloads", () => {
		const { views } = run([
			snapshot([], { busy: true }),
			frame({ type: "extension_ui_request", id: "ui1", method: "confirm", title: "Go?", message: "" }),
			{ t: "exit", code: 1 },
			snapshot([]),
		]);
		expect(views[2]).toMatchObject({ exited: true, exitCode: 1, busy: false, pendingUi: [] });
		expect(views[3]).toMatchObject({ exited: false, busy: false });
	});
});
