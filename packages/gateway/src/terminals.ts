import type { TermInfo, TermServerMsg } from "@romp/protocol";
import type { Subprocess } from "bun";
import { Scrollback } from "./scrollback.ts";
import { newId } from "./util.ts";
import { sendJson, type Socket } from "./ws.ts";

const REPLAY_BYTES = 2 * 1024 * 1024;
/** A client this far behind is dropped rather than buffering without bound; it reconnects and replays. */
const MAX_CLIENT_BACKLOG = 8 * 1024 * 1024;

export interface TerminalSpawn {
	argv: string[];
	/** Confined realpath. */
	cwd: string;
	cols: number;
	rows: number;
	title: string;
}

/** One PTY process shared by any number of WebSocket clients. */
export class TerminalSession {
	readonly id = newId();
	readonly createdAt = Date.now();
	readonly title: string;
	readonly cwd: string;
	private cols: number;
	private rows: number;
	private readonly clients = new Set<Socket>();
	private readonly scrollback = new Scrollback(REPLAY_BYTES);
	private readonly decoder = new TextDecoder();
	private readonly proc: Subprocess;
	private readonly terminal: Bun.Terminal;
	private exitCode: number | null = null;
	private exited = false;

	constructor(spawn: TerminalSpawn) {
		this.title = spawn.title;
		this.cwd = spawn.cwd;
		this.cols = spawn.cols;
		this.rows = spawn.rows;
		this.proc = Bun.spawn(spawn.argv, {
			cwd: spawn.cwd,
			env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
			terminal: {
				cols: spawn.cols,
				rows: spawn.rows,
				name: "xterm-256color",
				data: (_terminal, bytes) => this.output(this.decoder.decode(bytes, { stream: true }), bytes.byteLength),
			},
		});
		const terminal = this.proc.terminal;
		if (!terminal) throw new Error("PTY was not created");
		this.terminal = terminal;
		void this.proc.exited.then((code) => {
			// Let the PTY drain whatever the process wrote last before reporting the exit.
			setTimeout(() => {
				this.output(this.decoder.decode(), 0);
				this.exited = true;
				this.exitCode = code;
				this.terminal.close();
				for (const ws of this.clients) sendJson(ws, { t: "exit", code } satisfies TermServerMsg);
			}, 50);
		});
	}

	info(): TermInfo {
		return {
			id: this.id,
			title: this.title,
			cwd: this.cwd,
			cols: this.cols,
			rows: this.rows,
			createdAt: this.createdAt,
			clients: this.clients.size,
			exited: this.exited,
			exitCode: this.exitCode,
		};
	}

	attach(ws: Socket): void {
		sendJson(ws, { t: "replay", d: this.scrollback.text(), cols: this.cols, rows: this.rows } satisfies TermServerMsg);
		if (this.exited) sendJson(ws, { t: "exit", code: this.exitCode } satisfies TermServerMsg);
		this.clients.add(ws);
	}

	detach(ws: Socket): void {
		this.clients.delete(ws);
	}

	input(data: string): void {
		if (!this.exited) this.terminal.write(data);
	}

	resize(cols: number, rows: number): void {
		if (this.exited || (cols === this.cols && rows === this.rows)) return;
		this.cols = cols;
		this.rows = rows;
		this.terminal.resize(cols, rows);
		for (const ws of this.clients) sendJson(ws, { t: "resize", cols, rows } satisfies TermServerMsg);
	}

	/** Hangs up the PTY (SIGHUP to the shell, like closing a terminal window) and disconnects clients. */
	kill(): void {
		for (const ws of this.clients) ws.close(4410, "terminal closed");
		this.clients.clear();
		if (this.exited) return;
		this.proc.kill("SIGHUP");
		const timer = setTimeout(() => this.proc.kill("SIGKILL"), 3_000);
		void this.proc.exited.then(() => clearTimeout(timer));
	}

	private output(text: string, bytes: number): void {
		if (text === "") return;
		this.scrollback.push(text, bytes);
		const msg = JSON.stringify({ t: "out", d: text } satisfies TermServerMsg);
		for (const ws of this.clients) {
			if (ws.getBufferedAmount() > MAX_CLIENT_BACKLOG) ws.close(1013, "client too slow");
			else ws.send(msg, true);
		}
	}
}

export class TerminalManager {
	private readonly terms = new Map<string, TerminalSession>();

	list(): TermInfo[] {
		return [...this.terms.values()].map((term) => term.info()).sort((a, b) => a.createdAt - b.createdAt);
	}

	get(id: string): TerminalSession | undefined {
		return this.terms.get(id);
	}

	create(spawn: TerminalSpawn): TerminalSession {
		const term = new TerminalSession(spawn);
		this.terms.set(term.id, term);
		return term;
	}

	remove(id: string): boolean {
		const term = this.terms.get(id);
		if (!term) return false;
		this.terms.delete(id);
		term.kill();
		return true;
	}

	shutdown(): void {
		for (const id of [...this.terms.keys()]) this.remove(id);
	}
}
