import type { AgentInfo } from "@romp/protocol";

/**
 * View model of one agent session, built by `reduce` from the gateway's `snapshot` and the OMP frames that follow
 * (see oh-my-pi docs/rpc.md: message lifecycle with `messageUpdates: "delta"`, tool execution events, queue snapshots
 * and the extension UI sub-protocol).
 */
export interface AgentView {
	/** False until the first snapshot arrives. */
	loaded: boolean;
	info: AgentInfo | null;
	items: Item[];
	/** Tool executions keyed by tool call id; `ToolBlock`s in assistant items look their run up here. */
	tools: Record<string, ToolRun>;
	/** Displayable steering / follow-up queue (OMP `queue_update`, `get_state.queuedMessages`). */
	queue: { steering: string[]; followUp: string[] };
	/** This client's sends that the transcript or queue has not reflected yet. */
	outbox: Outgoing[];
	/** Unanswered extension dialogs, oldest first. */
	pendingUi: UiRequest[];
	/** Extension `setStatus` texts by key. */
	statuses: Record<string, string>;
	/** Extension `setWidget` lines by key. */
	widgets: Record<string, Widget>;
	busy: boolean;
	/** Client time the current run started; drives the "Working · 0:42" clock. */
	busySince: number | null;
	activity: Activity | null;
	exited: boolean;
	exitCode: number | null;
}

export type Item = UserItem | AssistantItem | NoticeItem | ShellItem;

export interface UserItem {
	kind: "user";
	key: string;
	text: string;
	/** `data:` URLs of attached images. */
	images: string[];
	/** Delivered into a running turn as a steer. */
	steering: boolean;
	timestamp: number;
}

export interface AssistantItem {
	kind: "assistant";
	key: string;
	/** Aligned with the message's content indices; null marks block kinds the pane does not render. */
	blocks: Array<Block | null>;
	/** Message is still streaming (between `message_start` and `message_end`). */
	streaming: boolean;
	/** Index of the block currently receiving deltas, or -1. */
	openBlock: number;
	stopReason: string | null;
	errorMessage: string | null;
	timestamp: number;
}

export type Block = TextBlock | ThinkingBlock | ImageBlock | ToolBlock;

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ThinkingBlock {
	type: "thinking";
	text: string;
	/** Client times bracketing a live-streamed block; null for blocks loaded from history. */
	startedAt: number | null;
	endedAt: number | null;
}

export interface ImageBlock {
	type: "image";
	src: string;
}

export interface ToolBlock {
	type: "tool";
	id: string;
	name: string;
	/** Parsed arguments; empty while the call is still streaming. */
	args: Record<string, unknown>;
	/** Raw argument JSON received so far while streaming (`toolcall_delta`). */
	partialArgs: string;
	/** OMP's one-line description of the call (`toolCall.intent`). */
	intent: string | null;
}

export type ToolStatus = "running" | "done" | "error" | "interrupted";

export interface ToolRun {
	status: ToolStatus;
	/** Text output: the live partial result while running, the final result after. */
	output: string;
	images: string[];
	details: Record<string, unknown> | null;
	/** Edit tool diffs per file (live `tool_stream_update` while running, final result details after). */
	diffs: FileDiff[] | null;
	/** Client time `tool_execution_start` arrived; null when the run was loaded from history. */
	startedAt: number | null;
	durationMs: number | null;
}

/** One file of an edit, in OMP's `-12|old` / `+12|new` / ` 12|context` line format. */
export interface FileDiff {
	path: string | null;
	diff: string;
}

/** Extension or system message shown as a compact, expandable row. */
export interface NoticeItem {
	kind: "notice";
	key: string;
	label: string;
	text: string;
	tone: "neutral" | "warning" | "danger";
	timestamp: number;
}

/** A `!command` (bash) or `$code` (python) the user ran through OMP directly. */
export interface ShellItem {
	kind: "shell";
	key: string;
	language: "bash" | "python";
	command: string;
	output: string;
	exitCode: number | null;
	cancelled: boolean;
	timestamp: number;
}

export type SendKind = "prompt" | "steer" | "follow_up";

export interface Outgoing {
	reqId: string;
	kind: SendKind;
	text: string;
	/** The gateway acknowledged the command. */
	acked: boolean;
	/** Sent on a connection that has since dropped, so its `response` will never arrive. */
	orphan: boolean;
}

export interface Widget {
	lines: string[];
	placement: "aboveEditor" | "belowEditor";
}

export type Activity =
	| { kind: "retry"; attempt: number; maxAttempts: number; delayMs: number; message: string; since: number }
	| { kind: "compacting"; since: number };

export interface AskOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface AskQuestion {
	id: string;
	question: string;
	header?: string;
	options: AskOption[];
	multi?: boolean;
	recommended?: number;
}

/** Dialog methods of `extension_ui_request`; presentation methods never become pending requests. */
export type UiRequest = (
	| { method: "select"; title: string; options: string[]; optionDetails?: Array<{ description?: string }> }
	| { method: "confirm"; title: string; message: string }
	| { method: "input"; title: string; placeholder?: string; secret?: boolean }
	| { method: "editor"; title: string; prefill?: string; promptStyle?: boolean }
	| { method: "ask"; questions: AskQuestion[] }
) & {
	id: string;
	/** Milliseconds OMP waits before resolving the dialog to its default. */
	timeout?: number;
	/** Client time the request arrived (for the timeout countdown). */
	receivedAt: number;
};

/** `extension_ui_response` payloads (oh-my-pi `RpcExtensionUIResponse`). */
export type UiAnswer =
	| { value: string }
	| { confirmed: boolean }
	| { cancelled: true }
	| { answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }> };

/** Side effects the pane performs for a reduced input; the reducer itself stays pure. */
export type Effect =
	| { type: "toast"; message: string; tone: "neutral" | "danger" | "success" }
	/** Put text back into the composer (a send failed or could not be confirmed). */
	| { type: "restore"; text: string }
	/** Extension `set_editor_text`: replace the composer text. */
	| { type: "editor"; text: string }
	| { type: "open-url"; url: string; instructions?: string };
