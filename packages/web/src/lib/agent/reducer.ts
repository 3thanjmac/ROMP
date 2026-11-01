/**
 * Pure reducer from the gateway's agent socket messages (plus this client's own optimistic sends) to `AgentView`.
 *
 * Message streaming follows OMP's `messageUpdates: "delta"` projection: assistant content is rebuilt block by block
 * from `*_start` / `*_delta` / `*_end` events keyed by `contentIndex`, and `message_end` carries the authoritative
 * message. `message_start` content is ignored for assistant messages because OMP serializes it lazily, so it can
 * already hold text that later deltas deliver.
 */
import type { AgentInfo, AgentServerMsg } from "@romp/protocol";
import type {
	AgentView,
	AssistantItem,
	Block,
	Effect,
	FileDiff,
	Item,
	NoticeItem,
	Outgoing,
	SendKind,
	ToolBlock,
	ToolRun,
	ToolStatus,
	UserItem,
} from "./types";
import { imageSrc, isRec, num, type Rec, readContent, readUiRequest, str, stripAnsi, strings } from "./wire";

export type Input =
	| AgentServerMsg
	/** This client sent a prompt/steer/follow-up (`reqId` correlates the gateway's `response`). */
	| { t: "sent"; reqId: string; kind: SendKind; text: string }
	/** This client answered a dialog (or its timeout passed); hide it before the gateway's echo arrives. */
	| { t: "answered"; id: string }
	/** The socket (re)connected; responses to earlier sends are lost. */
	| { t: "connected" };

export interface Step {
	view: AgentView;
	effects: Effect[];
}

const NONE: Effect[] = [];

export function emptyView(): AgentView {
	return {
		loaded: false,
		info: null,
		items: [],
		tools: {},
		queue: { steering: [], followUp: [] },
		outbox: [],
		pendingUi: [],
		statuses: {},
		widgets: {},
		busy: false,
		busySince: null,
		activity: null,
		exited: false,
		exitCode: null,
		startError: null,
	};
}

/** `now` is the client clock when the input arrived; it timestamps thinking and tool durations. */
export function reduce(view: AgentView, input: Input, now: number): Step {
	switch (input.t) {
		case "snapshot":
			return snapshot(view, input, now);
		case "frame":
			return frame(view, input.frame, now);
		case "response":
			return response(view, input);
		case "info":
			return { view: withInfo(view, input.info), effects: NONE };
		case "exit":
			return { view: terminate(view, input.code), effects: NONE };
		case "error":
			return { view: { ...view, startError: input.message }, effects: NONE };
		case "sent": {
			const entry: Outgoing = { reqId: input.reqId, kind: input.kind, text: input.text, acked: false, orphan: false };
			return { view: { ...view, outbox: [...view.outbox, entry] }, effects: NONE };
		}
		case "answered":
			return { view: dropUi(view, input.id), effects: NONE };
		case "connected":
			if (view.outbox.length === 0) return { view, effects: NONE };
			return { view: { ...view, outbox: view.outbox.map(o => ({ ...o, orphan: true })) }, effects: NONE };
	}
}

// ───────────────────────────── Snapshot ─────────────────────────────

function snapshot(prev: AgentView, msg: Extract<AgentServerMsg, { t: "snapshot" }>, now: number): Step {
	const state = isRec(msg.state) ? msg.state : {};
	const busy = msg.info.busy || state.isStreaming === true;
	const { items, tools } = transcript(msg.messages, busy);
	const queued = isRec(state.queuedMessages) ? state.queuedMessages : {};
	const queue = { steering: strings(queued.steering), followUp: strings(queued.followUp) };
	const pendingUi = msg.pendingUi.flatMap(raw => {
		const req = isRec(raw) ? readUiRequest(raw, now) : null;
		return req ? [req] : [];
	});

	// Sends whose `response` was lost with the previous connection: an unacknowledged one the snapshot does not show
	// as delivered or queued goes back into the composer rather than vanishing. Sends on the live connection (a
	// snapshot also follows an OMP respawn) keep waiting for their response.
	const delivered = [
		...items
			.filter((i): i is UserItem => i.kind === "user")
			.slice(-10)
			.map(i => i.text),
		...queue.steering,
		...queue.followUp,
	];
	const effects: Effect[] = [];
	const outbox: Outgoing[] = [];
	for (const entry of prev.outbox) {
		const at = delivered.findIndex(text => text.trim() === entry.text.trim());
		if (at >= 0) delivered.splice(at, 1);
		else if (!entry.orphan) outbox.push(entry);
		else if (!entry.acked) effects.push({ type: "restore", text: entry.text });
	}
	if (effects.length > 0) {
		effects.push({
			type: "toast",
			message: "Your last message may not have reached the agent. It's back in the composer.",
			tone: "neutral",
		});
	}

	const sameAgent = prev.info?.id === msg.info.id;
	const view: AgentView = {
		loaded: true,
		info: msg.info,
		items,
		tools,
		queue,
		outbox,
		pendingUi,
		statuses: sameAgent ? prev.statuses : {},
		widgets: sameAgent ? prev.widgets : {},
		busy,
		busySince: busy ? (sameAgent && prev.busySince !== null ? prev.busySince : runStart(items, now)) : null,
		activity: null,
		exited: msg.info.exited,
		exitCode: msg.info.exitCode,
		startError: null,
	};
	return { view, effects };
}

/** Converts a `get_messages` transcript; tool results attach to their calls instead of becoming items. */
function transcript(messages: unknown[], busy: boolean): { items: Item[]; tools: Record<string, ToolRun> } {
	const items: Item[] = [];
	const tools: Record<string, ToolRun> = {};
	const callEnds = new Map<string, number>();
	messages.forEach((message, index) => {
		if (!isRec(message)) return;
		if (message.role === "toolResult") {
			const id = str(message.toolCallId);
			if (!id) return;
			const at = num(message.timestamp);
			const end = callEnds.get(id);
			const fallback = at !== undefined && end !== undefined && at >= end ? at - end : null;
			tools[id] = finishedRun(undefined, message, message.isError === true, null, fallback);
			return;
		}
		const item = messageItem(message, `s${index}`);
		if (!item) return;
		if (item.kind === "assistant") {
			const end = num(message.completedAt);
			if (end !== undefined) for (const block of item.blocks) if (block?.type === "tool") callEnds.set(block.id, end);
		}
		items.push(item);
	});
	// Calls without a recorded result are executing in the live turn (only in the last assistant message) or
	// were cut off by an abort or crash.
	let last = true;
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item?.kind !== "assistant") continue;
		for (const block of item.blocks) {
			if (block?.type === "tool" && !tools[block.id]) tools[block.id] = emptyRun(busy && last ? "running" : "interrupted");
		}
		last = false;
	}
	return { items, tools };
}

/** Best guess at when the current run started, for clients that attach mid-run. */
function runStart(items: Item[], now: number): number {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item?.kind !== "user") continue;
		const age = now - item.timestamp;
		return age >= 0 && age < 6 * 3600_000 ? item.timestamp : now;
	}
	return now;
}

// ───────────────────────────── Messages ─────────────────────────────

function timestamp(message: Rec): number {
	return num(message.timestamp) ?? 0;
}

function messageItem(message: Rec, key: string): Item | null {
	switch (message.role) {
		case "user":
			return userItem(message, key);
		case "assistant":
			return assistantItem(message, key, undefined, 0);
		case "custom":
		case "hookMessage":
			return customNotice(message, key);
		case "bashExecution":
		case "pythonExecution": {
			const bash = message.role === "bashExecution";
			return {
				kind: "shell",
				key,
				language: bash ? "bash" : "python",
				command: str(bash ? message.command : message.code) ?? "",
				output: str(message.output) ?? "",
				exitCode: num(message.exitCode) ?? null,
				cancelled: message.cancelled === true,
				timestamp: timestamp(message),
			};
		}
		case "compactionSummary":
			return notice(key, "Context compacted", str(message.summary) ?? "", "neutral", timestamp(message));
		case "branchSummary":
			return notice(key, "Branch summary", str(message.summary) ?? "", "neutral", timestamp(message));
		case "fileMention": {
			const paths = (Array.isArray(message.files) ? message.files : []).flatMap(f =>
				isRec(f) && typeof f.path === "string" ? [f.path] : [],
			);
			if (paths.length === 0) return null;
			const label = paths.length === 1 ? `Attached ${paths[0]}` : `Attached ${paths.length} files`;
			return notice(key, label, paths.join("\n"), "neutral", timestamp(message));
		}
		default:
			// `developer` messages and unknown roles are model context, not conversation.
			return null;
	}
}

function userItem(message: Rec, key: string): Item | null {
	if (message.synthetic === true) return null;
	const { text, images } = readContent(message.content);
	if (message.attribution === "agent") return notice(key, "Agent message", text, "neutral", timestamp(message));
	return { kind: "user", key, text, images, steering: message.steering === true, timestamp: timestamp(message) };
}

function customNotice(message: Rec, key: string): NoticeItem | null {
	if (message.display !== true) return null;
	const type = str(message.customType);
	const details = isRec(message.details) ? message.details : {};
	let text = readContent(message.content).text;
	// System notices arrive wrapped in a single pseudo-tag, e.g. `<system-notice>…</system-notice>`.
	const wrapped = /^<([a-z][a-z-]*)>\n?([\s\S]*?)\n?<\/\1>$/.exec(text.trim());
	if (wrapped?.[2] !== undefined) text = wrapped[2];
	let label: string;
	if (type === "skill-prompt") label = `Skill ${str(details.name) ?? ""}`.trim();
	else if (type === "async-result") label = "Background job finished";
	else if (!type || type === "custom-message") label = "Extension message";
	else label = humanize(type);
	return notice(key, label, text, "neutral", timestamp(message));
}

function humanize(type: string): string {
	const words = type.replace(/[-_]+/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function notice(key: string, label: string, text: string, tone: NoticeItem["tone"], at: number): NoticeItem {
	return { kind: "notice", key, label, text, tone, timestamp: at };
}

/** Assistant message from a full `AssistantMessage`; `prev` keeps live thinking timings across `message_end`. */
function assistantItem(message: Rec, key: string, prev: AssistantItem | undefined, now: number): AssistantItem {
	const content = Array.isArray(message.content) ? message.content : [];
	const blocks = content.map((raw, i) => {
		const block = toBlock(raw);
		const before = prev?.blocks[i];
		if (block?.type === "thinking" && before?.type === "thinking" && before.startedAt !== null) {
			return { ...block, startedAt: before.startedAt, endedAt: before.endedAt ?? now };
		}
		return block;
	});
	return {
		kind: "assistant",
		key,
		blocks,
		streaming: false,
		openBlock: -1,
		stopReason: str(message.stopReason) ?? null,
		errorMessage: str(message.errorMessage) ?? null,
		timestamp: timestamp(message),
	};
}

function toBlock(raw: unknown): Block | null {
	if (!isRec(raw)) return null;
	switch (raw.type) {
		case "text":
			return { type: "text", text: str(raw.text) ?? "" };
		case "thinking": {
			const text = str(raw.thinking) ?? "";
			// Narration is prose addressed to the user that the provider returned as a thinking block.
			return raw.narration === true ? { type: "text", text } : { type: "thinking", text, startedAt: null, endedAt: null };
		}
		case "image": {
			const src = imageSrc(raw);
			return src ? { type: "image", src } : null;
		}
		case "toolCall":
			return toolBlock(raw);
		default:
			return null;
	}
}

function toolBlock(raw: Rec): ToolBlock | null {
	const id = str(raw.id);
	const name = str(raw.name);
	if (!id || !name) return null;
	const args = isRec(raw.arguments) ? raw.arguments : {};
	return { type: "tool", id, name, args, partialArgs: "", intent: str(raw.intent) ?? str(args.i) ?? null };
}

function streamingItem(key: string, at: number): AssistantItem {
	return {
		kind: "assistant",
		key,
		blocks: [],
		streaming: true,
		openBlock: -1,
		stopReason: null,
		errorMessage: null,
		timestamp: at,
	};
}

function findItem(items: Item[], key: string): number {
	for (let i = items.length - 1; i >= 0; i--) if (items[i]?.key === key) return i;
	return -1;
}

function messageStart(view: AgentView, f: Rec, now: number): AgentView {
	const message = isRec(f.message) ? f.message : null;
	const id = str(f.messageId);
	if (!message || !id) return view;
	if (message.role === "toolResult") return toolResult(view, message, now);
	const key = `m:${id}`;
	if (findItem(view.items, key) >= 0) return view;
	const item =
		message.role === "assistant" ? streamingItem(key, timestamp(message)) : messageItem(message, key);
	if (!item) return view;
	const outbox = item.kind === "user" ? consume(view.outbox, item.text) : view.outbox;
	return { ...view, items: [...view.items, item], outbox };
}

function messageEnd(view: AgentView, f: Rec, now: number): AgentView {
	const message = isRec(f.message) ? f.message : null;
	const id = str(f.messageId);
	if (!message || !id) return view;
	if (message.role === "toolResult") return toolResult(view, message, now);
	const key = `m:${id}`;
	const index = findItem(view.items, key);
	const prev = index >= 0 ? view.items[index] : undefined;
	const item =
		message.role === "assistant"
			? assistantItem(message, key, prev?.kind === "assistant" ? prev : undefined, now)
			: messageItem(message, key);
	if (index < 0) {
		if (!item) return view;
		const outbox = item.kind === "user" ? consume(view.outbox, item.text) : view.outbox;
		return { ...view, items: [...view.items, item], outbox };
	}
	const items = view.items.slice();
	if (item) items[index] = item;
	else items.splice(index, 1);
	return { ...view, items };
}

function messageUpdate(view: AgentView, f: Rec, now: number): AgentView {
	const id = str(f.messageId);
	const event = isRec(f.assistantMessageEvent) ? f.assistantMessageEvent : null;
	if (!id || !event) return view;
	const key = `m:${id}`;
	const items = view.items.slice();
	let index = findItem(items, key);
	if (index < 0) {
		// Attached mid-message without its start: rebuild from the deltas that follow.
		items.push(streamingItem(key, now));
		index = items.length - 1;
	}
	const item = items[index];
	if (item?.kind !== "assistant") return view;
	items[index] = applyEvent(item, event, now);
	return { ...view, items };
}

function setBlock(item: AssistantItem, index: number, block: Block, open: number): AssistantItem {
	const blocks = item.blocks.slice();
	while (blocks.length < index) blocks.push(null);
	blocks[index] = block;
	return { ...item, blocks, openBlock: open, streaming: true };
}

function applyEvent(item: AssistantItem, event: Rec, now: number): AssistantItem {
	if (event.type === "start") {
		// A restart of the streaming message within its turn; each block's `*_end` stays authoritative.
		const message = isRec(event.message) ? event.message : {};
		const content = Array.isArray(message.content) ? message.content : [];
		return { ...item, blocks: content.map(toBlock), openBlock: -1, streaming: true };
	}
	const i = num(event.contentIndex);
	if (i === undefined || i < 0) return item;
	const current = item.blocks[i];
	switch (event.type) {
		case "text_start":
			return setBlock(item, i, { type: "text", text: "" }, i);
		case "thinking_start": {
			const shell = isRec(event.block) ? event.block : {};
			const block: Block =
				shell.narration === true ? { type: "text", text: "" } : { type: "thinking", text: "", startedAt: now, endedAt: null };
			return setBlock(item, i, block, i);
		}
		case "text_delta":
		case "thinking_delta": {
			const delta = str(event.delta);
			if (!delta) return item;
			if (current?.type === "text") return setBlock(item, i, { type: "text", text: current.text + delta }, i);
			if (current?.type === "thinking") return setBlock(item, i, { ...current, text: current.text + delta }, i);
			// Missed the block's start.
			const block: Block =
				event.type === "text_delta"
					? { type: "text", text: delta }
					: { type: "thinking", text: delta, startedAt: now, endedAt: null };
			return setBlock(item, i, block, i);
		}
		case "text_end": {
			const text = str(event.content) ?? (current?.type === "text" ? current.text : "");
			return setBlock(item, i, { type: "text", text }, -1);
		}
		case "thinking_end": {
			const text = str(event.content) ?? (current?.type === "thinking" || current?.type === "text" ? current.text : "");
			const block: Block =
				current?.type === "text"
					? { type: "text", text }
					: { type: "thinking", text, startedAt: current?.type === "thinking" ? current.startedAt : null, endedAt: now };
			return setBlock(item, i, block, -1);
		}
		case "toolcall_start": {
			const block = isRec(event.block) ? toolBlock(event.block) : null;
			return block ? setBlock(item, i, block, i) : item;
		}
		case "toolcall_delta": {
			const delta = str(event.delta);
			if (current?.type !== "tool" || !delta) return item;
			return setBlock(item, i, { ...current, partialArgs: current.partialArgs + delta }, i);
		}
		case "toolcall_end": {
			const block = isRec(event.toolCall) ? toolBlock(event.toolCall) : null;
			return block ? setBlock(item, i, block, -1) : item;
		}
		case "image_end": {
			const src = isRec(event.content) ? imageSrc(event.content) : null;
			return src ? setBlock(item, i, { type: "image", src }, -1) : item;
		}
		default:
			// `done` / `error`: `message_end` follows with the final message.
			return item;
	}
}

// ───────────────────────────── Tools ─────────────────────────────

function emptyRun(status: ToolStatus, startedAt: number | null = null): ToolRun {
	return { status, output: "", images: [], details: null, diffs: null, startedAt, durationMs: null };
}

function readDiffs(details: Rec | null): FileDiff[] | null {
	if (!details) return null;
	const diff = str(details.diff);
	if (diff) return [{ path: str(details.path) ?? null, diff }];
	if (!Array.isArray(details.files)) return null;
	const diffs = details.files.flatMap(f =>
		isRec(f) && typeof f.diff === "string" && f.diff ? [{ path: str(f.path) ?? null, diff: f.diff }] : [],
	);
	return diffs.length > 0 ? diffs : null;
}

/** Final run from a tool result (`tool_execution_end.result` or a `toolResult` message). */
function finishedRun(
	prev: ToolRun | undefined,
	result: Rec,
	isError: boolean,
	now: number | null,
	fallbackMs: number | null,
): ToolRun {
	const { text, images } = readContent(result.content);
	const details = isRec(result.details) ? result.details : null;
	const startedAt = prev?.startedAt ?? null;
	const wall = details ? num(details.wallTimeMs) : undefined;
	return {
		status: isError ? "error" : "done",
		output: text,
		images,
		details,
		diffs: readDiffs(details) ?? prev?.diffs ?? null,
		startedAt,
		durationMs: wall ?? (startedAt !== null && now !== null ? now - startedAt : fallbackMs),
	};
}

function setRun(view: AgentView, id: string, run: ToolRun): AgentView {
	return { ...view, tools: { ...view.tools, [id]: run } };
}

/** A `toolResult` message only fills in runs whose `tool_execution_end` this client missed. */
function toolResult(view: AgentView, message: Rec, now: number): AgentView {
	const id = str(message.toolCallId);
	if (!id) return view;
	const run = view.tools[id];
	if (run && run.status !== "running") return view;
	return setRun(view, id, finishedRun(run, message, message.isError === true, now, null));
}

function toolEvent(view: AgentView, f: Rec, now: number): AgentView {
	const id = str(f.toolCallId);
	if (!id) return view;
	const run = view.tools[id];
	switch (f.type) {
		case "tool_execution_start":
			// Resumed calls can start after a placeholder marked them interrupted.
			if (run && run.status !== "interrupted") return view;
			return setRun(view, id, emptyRun("running", now));
		case "tool_execution_update": {
			// Late updates (an aborted command's cancellation notice, a backgrounded job) never reopen a finished run.
			if (run && run.status !== "running") return view;
			const partial = isRec(f.partialResult) ? f.partialResult : null;
			if (!partial) return view;
			const { text, images } = readContent(partial.content);
			const base = run ?? emptyRun("running");
			return setRun(view, id, { ...base, output: text, images, details: isRec(partial.details) ? partial.details : base.details });
		}
		case "tool_stream_update": {
			if (run && run.status !== "running") return view;
			const update = isRec(f.update) ? f.update : null;
			const diffs = readDiffs(update);
			return diffs ? setRun(view, id, { ...(run ?? emptyRun("running")), diffs }) : view;
		}
		case "tool_execution_end": {
			if (run && run.status !== "running") return view;
			const result = isRec(f.result) ? f.result : {};
			return setRun(view, id, finishedRun(run, result, f.isError === true, now, null));
		}
		default:
			return view;
	}
}

// ───────────────────────────── Run lifecycle ─────────────────────────────

function setBusy(view: AgentView, busy: boolean, now: number): AgentView {
	if (view.busy === busy) return view;
	return { ...view, busy, busySince: busy ? now : null };
}

/** The run yielded (or the process ended): close anything still marked live. */
function settle(view: AgentView): AgentView {
	let items = view.items;
	let tools = view.tools;
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item?.kind !== "assistant") continue;
		if (item.streaming) {
			if (items === view.items) items = items.slice();
			items[i] = { ...item, streaming: false, openBlock: -1 };
		}
		for (const block of item.blocks) {
			if (block?.type !== "tool") continue;
			const run = tools[block.id];
			if (run && run.status !== "running") continue;
			if (tools === view.tools) tools = { ...tools };
			tools[block.id] = run ? { ...run, status: "interrupted" } : emptyRun("interrupted");
		}
	}
	return {
		...view,
		items,
		tools,
		busy: false,
		busySince: null,
		activity: null,
		// Acknowledged sends that never surfaced (slash commands, skill prompts) were consumed by this run.
		outbox: view.outbox.filter(o => !o.acked),
	};
}

function terminate(view: AgentView, code: number | null): AgentView {
	return { ...settle(view), exited: true, exitCode: code, pendingUi: [] };
}

function withInfo(view: AgentView, info: AgentInfo): AgentView {
	// `busy` follows the frames; the gateway derives `info.busy` from the same `agent_start`/`agent_end`.
	if (info.exited && !view.exited) return { ...terminate(view, info.exitCode), info };
	return { ...view, info, exited: info.exited, exitCode: info.exitCode };
}

// ───────────────────────────── Queue & outbox ─────────────────────────────

/** Drops the first outbox entry the transcript now shows. */
function consume(outbox: Outgoing[], text: string): Outgoing[] {
	const index = outbox.findIndex(o => o.text.trim() === text.trim());
	return index < 0 ? outbox : outbox.filter((_, i) => i !== index);
}

function queueUpdate(view: AgentView, f: Rec): AgentView {
	const queue = { steering: strings(f.steering), followUp: strings(f.followUp) };
	let outbox = view.outbox;
	for (const text of [...queue.steering, ...queue.followUp]) outbox = consume(outbox, text);
	return { ...view, queue, outbox };
}

function response(view: AgentView, msg: Extract<AgentServerMsg, { t: "response" }>): Step {
	const index = view.outbox.findIndex(o => o.reqId === msg.reqId);
	const entry = view.outbox[index];
	if (!entry) return { view, effects: NONE };
	const rest = view.outbox.filter((_, i) => i !== index);
	if (!msg.success) {
		return {
			view: { ...view, outbox: rest },
			effects: [
				{ type: "restore", text: entry.text },
				{ type: "toast", message: msg.error ?? "The agent did not accept that message.", tone: "danger" },
			],
		};
	}
	// A prompt that finished locally (a builtin slash command) never shows up in the transcript.
	if (isRec(msg.data) && msg.data.agentInvoked === false) return { view: { ...view, outbox: rest }, effects: NONE };
	const outbox = view.outbox.slice();
	outbox[index] = { ...entry, acked: true };
	return { view: { ...view, outbox }, effects: NONE };
}

// ───────────────────────────── Extension UI ─────────────────────────────

function dropUi(view: AgentView, id: string | undefined): AgentView {
	if (!id || !view.pendingUi.some(r => r.id === id)) return view;
	return { ...view, pendingUi: view.pendingUi.filter(r => r.id !== id) };
}

function uiRequest(view: AgentView, f: Rec, now: number): Step {
	switch (f.method) {
		case "cancel":
			return { view: dropUi(view, str(f.targetId)), effects: NONE };
		case "setStatus": {
			const key = str(f.statusKey);
			if (!key) return { view, effects: NONE };
			const statuses = { ...view.statuses };
			const text = str(f.statusText);
			if (text) statuses[key] = text;
			else delete statuses[key];
			return { view: { ...view, statuses }, effects: NONE };
		}
		case "setWidget": {
			const key = str(f.widgetKey);
			if (!key) return { view, effects: NONE };
			const lines = strings(f.widgetLines);
			if (lines.length === 0 && !(key in view.widgets)) return { view, effects: NONE };
			const widgets = { ...view.widgets };
			if (lines.length > 0) widgets[key] = { lines, placement: f.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor" };
			else delete widgets[key];
			return { view: { ...view, widgets }, effects: NONE };
		}
		case "notify": {
			const message = str(f.message);
			const tone = f.notifyType === "error" ? "danger" : "neutral";
			return { view, effects: message ? [{ type: "toast", message, tone }] : NONE };
		}
		case "set_editor_text":
			return { view, effects: [{ type: "editor", text: str(f.text) ?? "" }] };
		case "open_url": {
			const url = str(f.launchUrl) ?? str(f.url);
			return { view, effects: url ? [{ type: "open-url", url, instructions: str(f.instructions) }] : NONE };
		}
		default: {
			const req = readUiRequest(f, now);
			if (!req || view.pendingUi.some(r => r.id === req.id)) return { view, effects: NONE };
			return { view: { ...view, pendingUi: [...view.pendingUi, req] }, effects: NONE };
		}
	}
}

// ───────────────────────────── Frames ─────────────────────────────

function frame(view: AgentView, f: Rec & { type: string }, now: number): Step {
	switch (f.type) {
		case "message_start":
			return { view: messageStart(view, f, now), effects: NONE };
		case "message_update":
			return { view: messageUpdate(view, f, now), effects: NONE };
		case "message_end":
			return { view: messageEnd(view, f, now), effects: NONE };
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_stream_update":
		case "tool_execution_end":
			return { view: toolEvent(view, f, now), effects: NONE };
		case "agent_start":
			return { view: setBusy(view, true, now), effects: NONE };
		case "agent_end": {
			// `yielded: false` means the agent keeps working (retry, compaction continuation); older runtimes omit it.
			const yielded = typeof f.yielded === "boolean" ? f.yielded : f.isTerminal !== false;
			return { view: yielded ? settle(view) : view, effects: NONE };
		}
		case "prompt_result": {
			// The gateway rewrites command ids, so a locally finished prompt (an extension command that started no
			// turn and so never reaches `agent_end`) is matched to the oldest acknowledged prompt.
			if (f.agentInvoked !== false) return { view, effects: NONE };
			const index = view.outbox.findIndex(o => o.acked && o.kind === "prompt");
			if (index < 0) return { view, effects: NONE };
			return { view: { ...view, outbox: view.outbox.filter((_, i) => i !== index) }, effects: NONE };
		}
		case "session_settled":
			return {
				view: view.outbox.some(o => o.acked) ? { ...view, outbox: view.outbox.filter(o => !o.acked) } : view,
				effects: NONE,
			};
		case "queue_update":
			return { view: queueUpdate(view, f), effects: NONE };
		case "auto_retry_start":
			return {
				view: {
					...view,
					activity: {
						kind: "retry",
						attempt: num(f.attempt) ?? 1,
						maxAttempts: num(f.maxAttempts) ?? 1,
						delayMs: num(f.delayMs) ?? 0,
						message: str(f.errorMessage) ?? "",
						since: now,
					},
				},
				effects: NONE,
			};
		case "auto_compaction_start":
			return { view: { ...view, activity: { kind: "compacting", since: now } }, effects: NONE };
		case "auto_retry_end":
			return { view: { ...view, activity: null }, effects: NONE };
		case "auto_compaction_end": {
			const done = isRec(f.result) && f.aborted !== true && f.skipped !== true;
			const items = done
				? [...view.items, notice(`e${view.items.length}`, "Context compacted", "", "neutral", now)]
				: view.items;
			const error = str(f.errorMessage);
			return {
				view: { ...view, items, activity: null },
				effects: error ? [{ type: "toast", message: `Compaction failed: ${error}`, tone: "danger" }] : NONE,
			};
		}
		case "command_output": {
			const text = stripAnsi(str(f.text) ?? "").trim();
			if (!text) return { view, effects: NONE };
			return {
				view: { ...view, items: [...view.items, notice(`e${view.items.length}`, "Command output", text, "neutral", now)] },
				effects: NONE,
			};
		}
		case "extension_ui_request":
			return uiRequest(view, f, now);
		case "extension_ui_response":
			// The gateway echoes every answer to all clients so other tabs drop the card.
			return { view: dropUi(view, str(f.id)), effects: NONE };
		case "notice": {
			const message = str(f.message);
			return {
				view,
				effects: message ? [{ type: "toast", message, tone: f.level === "error" ? "danger" : "neutral" }] : NONE,
			};
		}
		case "rpc_frame_error":
			return {
				view,
				effects: [{ type: "toast", message: "Part of the agent's output was too large to deliver.", tone: "danger" }],
			};
		default:
			return { view, effects: NONE };
	}
}
