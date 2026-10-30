/**
 * One browser attachment to a gateway agent: owns the `/ws/agent/:id` socket, folds incoming messages through the
 * pure reducer once per animation frame, correlates rpc responses, and hands side effects to the pane.
 */
import type { AgentClientMsg, AgentServerMsg } from "@romp/protocol";
import { api } from "../api";
import { type ConnState, Socket } from "../conn/socket.svelte";
import { emptyView, type Input, reduce } from "./reducer";
import type { AgentView, Effect, SendKind, UiAnswer } from "./types";
import { isRec, str } from "./wire";

export interface RpcResult {
	success: boolean;
	data?: unknown;
	error?: string;
}

type RpcCommand = Extract<AgentClientMsg, { t: "rpc" }>["cmd"];

const OFFLINE: RpcResult = { success: false, error: "You're offline. Try again once the connection is back." };

export class AgentSession {
	view: AgentView = $state.raw(emptyView());
	/** An abort is in flight. */
	stopping = $state(false);

	readonly agentId: string;
	readonly #socket: Socket<AgentServerMsg, AgentClientMsg>;
	readonly #onEffect: (effect: Effect) => void;
	#inbox: Input[] = [];
	#scheduled = false;
	#disposed = false;
	#seq = 0;
	readonly #pending = new Map<string, (result: RpcResult) => void>();

	constructor(agentId: string, onEffect: (effect: Effect) => void) {
		this.agentId = agentId;
		this.#onEffect = onEffect;
		this.#socket = new Socket<AgentServerMsg, AgentClientMsg>({
			path: `/ws/agent/${encodeURIComponent(agentId)}`,
			onMessage: msg => this.#receive(msg),
			// Responses to requests sent on a previous connection never arrive.
			onOpen: () => {
				this.#settleAll({ success: false, error: "The connection dropped before the agent answered." });
				this.#apply({ t: "connected" });
			},
			stillExists: async () => (await api.agents.list()).some(a => a.id === agentId),
		});
	}

	get conn(): ConnState {
		return this.#socket.state;
	}

	get attempt(): number {
		return this.#socket.attempt;
	}

	/** Sends a prompt (idle) or a steer / follow-up (busy). False when the socket is not live; the caller keeps the text. */
	send(kind: SendKind, text: string): boolean {
		const reqId = this.#nextId();
		// `streamingBehavior` queues the prompt instead of failing if another client started a run meanwhile.
		const cmd: RpcCommand =
			kind === "prompt" ? { type: "prompt", message: text, streamingBehavior: "followUp" } : { type: kind, message: text };
		if (!this.#socket.send({ t: "rpc", reqId, cmd })) return false;
		this.#apply({ t: "sent", reqId, kind, text });
		return true;
	}

	/** Stops the run and takes queued steers/follow-ups back into the composer instead of dropping them. */
	async abort(): Promise<void> {
		this.stopping = true;
		const result = await this.request({ type: "abort_and_restore_queue" });
		if (!result.success) {
			this.stopping = false;
			this.#onEffect({ type: "toast", message: result.error ?? "Couldn't stop the agent.", tone: "danger" });
			return;
		}
		const data = isRec(result.data) ? result.data : {};
		const withdrawn = [data.steering, data.followUp].flatMap(list =>
			Array.isArray(list) ? list.flatMap(entry => (isRec(entry) && str(entry.text) ? [str(entry.text)!] : [])) : [],
		);
		if (withdrawn.length > 0) this.#onEffect({ type: "restore", text: withdrawn.join("\n\n") });
	}

	request(cmd: RpcCommand): Promise<RpcResult> {
		const reqId = this.#nextId();
		if (!this.#socket.send({ t: "rpc", reqId, cmd })) return Promise.resolve(OFFLINE);
		return new Promise(resolve => this.#pending.set(reqId, resolve));
	}

	/** Answers an extension dialog. False when the socket is not live. */
	answer(id: string, answer: UiAnswer): boolean {
		if (!this.#socket.send({ t: "ui", response: { type: "extension_ui_response", id, ...answer } })) return false;
		this.#apply({ t: "answered", id });
		return true;
	}

	/** A dialog's timeout passed: OMP resolved it to its default, so stop offering it. */
	expire(id: string): void {
		this.#apply({ t: "answered", id });
	}

	retryNow(): void {
		this.#socket.retryNow();
	}

	dispose(): void {
		this.#disposed = true;
		this.#settleAll({ success: false, error: "The agent window was closed." });
		this.#socket.dispose();
	}

	#nextId(): string {
		this.#seq += 1;
		return `${Date.now().toString(36)}-${this.#seq}`;
	}

	#settleAll(result: RpcResult): void {
		for (const resolve of this.#pending.values()) resolve(result);
		this.#pending.clear();
	}

	#receive(msg: AgentServerMsg): void {
		this.#inbox.push(msg);
		if (this.#scheduled) return;
		this.#scheduled = true;
		// One reduce + render per frame while streaming; hidden tabs still drain, just less often.
		if (document.visibilityState === "visible") requestAnimationFrame(() => this.#flush());
		else window.setTimeout(() => this.#flush(), 250);
	}

	/** Local inputs reduce immediately, after anything already received, so ordering is preserved. */
	#apply(input: Input): void {
		this.#inbox.push(input);
		this.#flush();
	}

	#flush(): void {
		this.#scheduled = false;
		if (this.#disposed) return;
		const inbox = this.#inbox;
		this.#inbox = [];
		const now = Date.now();
		const effects: Effect[] = [];
		let view = this.view;
		for (const input of inbox) {
			// An `exit` keeps the socket open: the gateway respawns OMP on the next command and sends a new snapshot.
			if (input.t === "response") {
				this.#pending.get(input.reqId)?.(input);
				this.#pending.delete(input.reqId);
			}
			const step = reduce(view, input, now);
			view = step.view;
			effects.push(...step.effects);
		}
		this.view = view;
		if (!view.busy) this.stopping = false;
		for (const effect of effects) this.#onEffect(effect);
	}
}
