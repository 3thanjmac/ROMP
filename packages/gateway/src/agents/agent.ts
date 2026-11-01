import type { AgentInfo, AgentServerMsg } from "@romp/protocol";
import type { Subprocess } from "bun";
import { errorMessage, isRecord, withTimeout } from "../util.ts";
import { sendJson, type Socket } from "../ws.ts";
import { ChunkDecoder, FrameError, LineSplitter, parseJson, type RpcFrame } from "./frames.ts";
import { type AgentNotice, exitNotice, NoticeTracker } from "./notices.ts";

/** What survives a gateway restart. */
export interface AgentRecord {
	id: string;
	title: string;
	cwd: string;
	createdAt: number;
	/** OMP session file, used to `switch_session` back into the conversation after a respawn. */
	sessionFile: string | null;
}

export interface AgentHost {
	omp: string;
	/** Called whenever a field of `AgentRecord` changes. */
	persist(): void;
	/** Called whenever the agent starts or finishes a turn. */
	busyChanged(): void;
	/** Called when the agent needs the user, finishes a turn, or stops unexpectedly. */
	notify(notice: AgentNotice): void;
}

interface RpcResponse {
	type: "response";
	id?: string;
	command?: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

type Waiter =
	| {
			kind: "internal";
			resolve(response: RpcResponse): void;
			reject(err: Error): void;
			onSync?: (response: RpcResponse) => void;
	  }
	| { kind: "client"; ws: Socket; reqId: string; command: string };

type OmpProcess = Subprocess<"pipe", "pipe", "pipe">;

const READY_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 5_000;
const MESSAGE_PAGE = 256;
/** Close code for "OMP could not start": the client stops reconnecting until the user retries. */
const START_FAILED = 4503;
const STDERR_TAIL_CHARS = 4096;
/** How long an early exit waits for OMP's stderr to drain before reporting why it failed. */
const STDERR_DRAIN_MS = 1_000;
/** `extension_ui_request` methods that wait for an `extension_ui_response`. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor", "ask"]);
/** Commands after which the session file may have changed. */
const SESSION_COMMANDS = new Set(["new_session", "switch_session", "branch", "fork", "open_session"]);

/**
 * One OMP session driven over `omp --mode rpc`. The process is spawned on demand (creation, a client
 * connecting or sending a command) and resumes its session file when respawned.
 */
export class Agent {
	private proc: OmpProcess | null = null;
	private starting: Promise<void> | null = null;
	private readyFrame: PromiseWithResolvers<RpcFrame> | null = null;
	private busy = false;
	private exited = false;
	private exitCode: number | null = null;
	private closed = false;
	/** Clients that received their snapshot and get every broadcast. */
	private readonly clients = new Set<Socket>();
	/** Clients waiting for their snapshot. `null` until the transcript is captured, then frames to replay. */
	private readonly joining = new Map<Socket, AgentServerMsg[] | null>();
	private readonly pendingUi = new Map<string, RpcFrame>();
	private readonly waiters = new Map<string, Waiter>();
	private readonly notices = new NoticeTracker();
	private nextId = 0;

	constructor(
		private readonly record: AgentRecord,
		readonly task: AgentInfo["task"],
		private readonly host: AgentHost,
		private initialPrompt: string | undefined,
	) {}

	get id(): string {
		return this.record.id;
	}

	get cwd(): string {
		return this.record.cwd;
	}

	toRecord(): AgentRecord {
		return { ...this.record };
	}

	info(): AgentInfo {
		return {
			id: this.record.id,
			title: this.record.title,
			cwd: this.record.cwd,
			createdAt: this.record.createdAt,
			busy: this.busy,
			clients: this.clients.size + this.joining.size,
			exited: this.exited,
			exitCode: this.exitCode,
			task: this.task,
		};
	}

	/** Spawns OMP unless it is running; resolves once it is ready for commands. */
	ensureRunning(): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Agent was removed"));
		if (!this.starting) {
			const respawn = this.proc !== null;
			const starting = this.start().then(
				() => {
					if (respawn) for (const ws of [...this.clients]) this.resnapshot(ws);
				},
				(err: unknown) => {
					// A failed start reports late (it waits for stderr); a newer start may own `starting` by then.
					if (this.starting === starting) this.starting = null;
					throw err;
				},
			);
			this.starting = starting;
		}
		return this.starting;
	}

	// ── Clients ──────────────────────────────────────────────────────────

	attach(ws: Socket): void {
		this.joining.set(ws, null);
		this.broadcastInfo();
		void this.sendSnapshot(ws);
	}

	detach(ws: Socket): void {
		const known = this.clients.delete(ws) || this.joining.delete(ws);
		for (const [id, waiter] of this.waiters) {
			if (waiter.kind === "client" && waiter.ws === ws) this.waiters.delete(id);
		}
		if (known) this.broadcastInfo();
	}

	async rpc(ws: Socket, reqId: string, cmd: Record<string, unknown> & { type: string }): Promise<void> {
		const id = `c${++this.nextId}`;
		try {
			await this.ensureRunning();
			this.waiters.set(id, { kind: "client", ws, reqId, command: cmd.type });
			this.write({ ...cmd, id });
		} catch (err) {
			this.waiters.delete(id);
			sendJson(ws, { t: "response", reqId, success: false, error: errorMessage(err) } satisfies AgentServerMsg);
		}
	}

	answerUi(response: Record<string, unknown>): void {
		const id = response.id;
		if (typeof id !== "string" || !this.pendingUi.has(id) || !this.proc || this.exited) return;
		this.pendingUi.delete(id);
		this.write(response);
		this.broadcast({ t: "frame", frame: response as RpcFrame });
	}

	/** Disconnects every client with `code` and stops OMP. */
	async close(code: number, reason: string): Promise<void> {
		this.closed = true;
		for (const ws of [...this.clients, ...this.joining.keys()]) ws.close(code, reason);
		this.clients.clear();
		this.joining.clear();
		await this.stop();
	}

	// ── Process lifecycle ────────────────────────────────────────────────

	private async start(): Promise<void> {
		const proc = Bun.spawn([this.host.omp, "--mode", "rpc"], {
			cwd: this.record.cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.proc = proc;
		this.exited = false;
		this.exitCode = null;
		this.setBusy(false);
		this.pendingUi.clear();
		this.readyFrame = Promise.withResolvers<RpcFrame>();
		void this.readStdout(proc);
		const stderr = this.readStderr(proc);
		void proc.exited.then((code) => this.onExit(proc, code, stderr));

		try {
			const ready = await withTimeout(this.readyFrame.promise, READY_TIMEOUT_MS, "omp did not become ready");
			const versions = ready.supportedProtocolVersions;
			if (Array.isArray(versions) && versions.includes(2)) {
				await this.command({ type: "negotiate_protocol", protocolVersion: 2 });
			}
			await this.command({ type: "set_event_filter", events: null, messageUpdates: "delta" });
			await this.command({ type: "set_ask_dialog", enabled: true });
			if (this.record.sessionFile) {
				const resumed = await this.call({ type: "switch_session", sessionPath: this.record.sessionFile });
				if (!resumed.success) {
					console.warn(`agent ${this.id}: could not resume ${this.record.sessionFile}: ${resumed.error}`);
				}
			}
			await this.refreshSessionFile();
			const prompt = this.initialPrompt;
			this.initialPrompt = undefined;
			if (prompt) await this.command({ type: "prompt", message: prompt });
		} catch (err) {
			proc.kill("SIGKILL");
			throw err;
		}
		this.broadcastInfo();
	}

	private async readStdout(proc: OmpProcess): Promise<void> {
		const lines = new LineSplitter();
		const chunks = new ChunkDecoder();
		try {
			for await (const bytes of proc.stdout) {
				for (const line of lines.push(bytes)) {
					const frame = chunks.push(parseJson(line));
					if (frame && this.proc === proc) this.onFrame(frame);
				}
			}
		} catch (err) {
			if (!(err instanceof FrameError)) throw err;
			console.error(`agent ${this.id}: ${err.message}; stopping omp`);
			proc.kill("SIGKILL");
		}
	}

	/** Logs OMP's stderr and resolves with its tail once the stream closes. */
	private async readStderr(proc: OmpProcess): Promise<string> {
		const decoder = new TextDecoder();
		let tail = "";
		for await (const bytes of proc.stderr) {
			const text = decoder.decode(bytes, { stream: true });
			tail = (tail + text).slice(-STDERR_TAIL_CHARS);
			const line = text.trimEnd();
			if (line) console.error(`agent ${this.id} stderr: ${line.slice(0, 4096)}`);
		}
		return tail;
	}

	private onExit(proc: OmpProcess, code: number | null, stderr: Promise<string>): void {
		if (this.proc !== proc) return;
		this.starting = null;
		this.exited = true;
		this.exitCode = code;
		this.setBusy(false);
		this.pendingUi.clear();
		const ready = this.readyFrame;
		if (ready) {
			// An exit before `ready` is a failed start: OMP explains why on stderr, which may still be draining.
			void withTimeout(stderr, STDERR_DRAIN_MS, "")
				.catch(() => "")
				.then((tail) => ready.reject(new Error(exitReason(code, tail))));
		}
		for (const [id, waiter] of this.waiters) {
			this.waiters.delete(id);
			if (waiter.kind === "internal") waiter.reject(new Error(`omp exited with code ${code}`));
			else sendJson(waiter.ws, { t: "response", reqId: waiter.reqId, success: false, error: "omp exited" } satisfies AgentServerMsg);
		}
		if (this.closed) return;
		this.host.notify(exitNotice(code));
		this.broadcast({ t: "exit", code });
		this.broadcastInfo();
	}

	/** Ends OMP the documented way (stdin EOF lets it flush the session), escalating to signals. */
	async stop(): Promise<void> {
		const proc = this.proc;
		if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
		proc.stdin.end();
		const gone = (ms: number) => withTimeout(proc.exited, ms, "").then(() => true, () => false);
		if (await gone(STOP_GRACE_MS)) return;
		proc.kill("SIGTERM");
		if (await gone(2_000)) return;
		proc.kill("SIGKILL");
		await proc.exited;
	}

	// ── Frames ───────────────────────────────────────────────────────────

	private onFrame(frame: RpcFrame): void {
		switch (frame.type) {
			case "ready":
				this.readyFrame?.resolve(frame);
				return;
			case "response":
				this.onResponse(frame as unknown as RpcResponse);
				return;
			case "extension_ui_request":
				if (typeof frame.id === "string" && DIALOG_METHODS.has(String(frame.method))) {
					this.pendingUi.set(frame.id, frame);
				} else if (frame.method === "cancel" && typeof frame.targetId === "string") {
					this.pendingUi.delete(frame.targetId);
				}
				break;
		}
		this.broadcast({ t: "frame", frame });
		if (frame.type === "agent_start" && !this.busy) {
			this.setBusy(true);
			this.broadcastInfo();
		} else if (frame.type === "agent_end" && frame.isTerminal !== false && this.busy) {
			this.setBusy(false);
			this.broadcastInfo();
		}
		const notice = this.notices.frame(frame);
		if (notice) this.host.notify(notice);
	}

	get isBusy(): boolean {
		return this.busy;
	}

	private setBusy(busy: boolean): void {
		if (this.busy === busy) return;
		this.busy = busy;
		this.host.busyChanged();
	}

	private onResponse(response: RpcResponse): void {
		const waiter = response.id === undefined ? undefined : this.waiters.get(response.id);
		if (!waiter || response.id === undefined) {
			if (!response.success) console.warn(`agent ${this.id}: ${response.command ?? "command"} failed: ${response.error}`);
			return;
		}
		this.waiters.delete(response.id);
		if (waiter.kind === "internal") {
			waiter.onSync?.(response);
			waiter.resolve(response);
			return;
		}
		sendJson(waiter.ws, {
			t: "response",
			reqId: waiter.reqId,
			success: response.success,
			data: response.data,
			error: response.error,
		} satisfies AgentServerMsg);
		if (response.success && SESSION_COMMANDS.has(waiter.command)) {
			this.refreshSessionFile().catch((err: unknown) => console.warn(`agent ${this.id}: ${errorMessage(err)}`));
		}
	}

	private write(cmd: Record<string, unknown>): void {
		const proc = this.proc;
		if (!proc || this.exited) throw new Error("omp is not running");
		proc.stdin.write(`${JSON.stringify(cmd)}\n`);
		proc.stdin.flush();
	}

	/**
	 * Sends a gateway-originated command. `onSync` runs synchronously when the response is read, before any
	 * later stdout frame is handled, which lets snapshots start buffering at exactly the right frame.
	 */
	private call(
		cmd: Record<string, unknown> & { type: string },
		onSync?: (response: RpcResponse) => void,
	): Promise<RpcResponse> {
		const id = `g${++this.nextId}`;
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		this.waiters.set(id, { kind: "internal", resolve, reject, onSync });
		try {
			this.write({ ...cmd, id });
		} catch (err) {
			this.waiters.delete(id);
			reject(err);
		}
		return withTimeout(promise, COMMAND_TIMEOUT_MS, `omp did not answer ${cmd.type}`).finally(() => this.waiters.delete(id));
	}

	private async command(cmd: Record<string, unknown> & { type: string }): Promise<unknown> {
		const response = await this.call(cmd);
		if (!response.success) throw new Error(`omp ${cmd.type} failed: ${response.error ?? "unknown error"}`);
		return response.data;
	}

	private async refreshSessionFile(): Promise<void> {
		const state = await this.command({ type: "get_state" });
		const file = isRecord(state) && typeof state.sessionFile === "string" ? state.sessionFile : null;
		if (file !== this.record.sessionFile) {
			this.record.sessionFile = file;
			this.host.persist();
		}
	}

	// ── Snapshots and broadcast ──────────────────────────────────────────

	private resnapshot(ws: Socket): void {
		this.clients.delete(ws);
		this.joining.set(ws, null);
		void this.sendSnapshot(ws);
	}

	private async sendSnapshot(ws: Socket): Promise<void> {
		const startBuffering = () => {
			if (this.joining.has(ws)) this.joining.set(ws, []);
		};
		let messages: unknown[];
		let state: unknown;
		try {
			await this.ensureRunning();
		} catch (err) {
			if (!this.joining.delete(ws)) return;
			const message = errorMessage(err);
			console.warn(`agent ${this.id}: could not start: ${message}`);
			sendJson(ws, { t: "error", message } satisfies AgentServerMsg);
			ws.close(START_FAILED, "agent could not start");
			return;
		}
		try {
			messages = await this.transcript(startBuffering);
			state = await this.command({ type: "get_state" });
		} catch (err) {
			if (!this.joining.delete(ws)) return;
			ws.close(1011, errorMessage(err).slice(0, 120));
			return;
		}
		const buffered = this.joining.get(ws);
		if (!this.joining.delete(ws)) return;
		this.clients.add(ws);
		sendJson(ws, {
			t: "snapshot",
			info: this.info(),
			messages,
			state,
			pendingUi: [...this.pendingUi.values()],
		} satisfies AgentServerMsg);
		for (const msg of buffered ?? []) sendJson(ws, msg);
	}

	/** The full transcript via `get_messages_page`, falling back to `get_messages` while the session is busy. */
	private async transcript(onCaptured: () => void): Promise<unknown[]> {
		const messages: unknown[] = [];
		let cursor: string | undefined;
		for (;;) {
			const page = await this.call(
				{ type: "get_messages_page", limit: MESSAGE_PAGE, ...(cursor ? { cursor } : {}) },
				(response) => {
					if (response.success && isRecord(response.data) && typeof response.data.nextCursor !== "string") onCaptured();
				},
			);
			if (!page.success || !isRecord(page.data) || !Array.isArray(page.data.messages)) break;
			messages.push(...page.data.messages);
			if (typeof page.data.nextCursor !== "string") return messages;
			cursor = page.data.nextCursor;
		}
		// Paging is refused while streaming and invalidated by concurrent appends: take the one-shot snapshot.
		const full = await this.call({ type: "get_messages" }, () => onCaptured());
		if (!full.success) throw new Error(`omp get_messages failed: ${full.error}`);
		const data = full.data;
		if (Array.isArray(data)) return data;
		if (isRecord(data) && Array.isArray(data.messages)) return data.messages;
		return [];
	}

	private broadcast(msg: AgentServerMsg): void {
		for (const ws of this.clients) sendJson(ws, msg);
		for (const queue of this.joining.values()) queue?.push(msg);
	}

	private broadcastInfo(): void {
		if (this.closed) return;
		this.broadcast({ t: "info", info: this.info() });
	}
}

/** OMP's own explanation for an early exit: the first paragraph it printed to stderr. */
function exitReason(code: number | null, stderr: string): string {
	const first = stderr.trim().split(/\n\s*\n/)[0]?.trim().replace(/\s+/g, " ");
	const base = `omp exited with code ${code}`;
	return first ? `${base}: ${first.slice(0, 500)}` : base;
}
