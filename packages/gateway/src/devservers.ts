/**
 * Dev servers started from the Browser pane. Each runs its folder's dev command in an ordinary gateway terminal
 * (so its logs are a terminal any window can attach to) and reports the port it ends up listening on, found by
 * matching listening sockets to the terminal's process tree.
 *
 * Exited servers stay listed for `EXITED_TTL_MS` so a polling client sees the exit code, then are dropped
 * (with their terminal, unless a window still shows it).
 */
import type { DevServerInfo } from "@romp/protocol";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";
import { HttpError } from "./http.ts";
import { listeningSockets, type TcpSocket } from "./procnet.ts";
import type { TerminalManager, TerminalSession } from "./terminals.ts";
import { newId } from "./util.ts";

/** Ports below this are where dev servers serve (Vite 5173, Next 3000, wrangler 8787); higher ones are usually internal. */
const DEV_PORT_MAX = 10_000;
/** How long a tree listening only on high ports may wait for a dev-range port before the high one counts. */
const HIGH_PORT_GRACE_MS = 3_000;
/** Poll every `pollMs` this long after start, then every `SLOW_POLL_MS` until a port shows up or it exits. */
const FAST_POLL_FOR_MS = 90_000;
const SLOW_POLL_MS = 5_000;
const STOP_GRACE_MS = 5_000;
const EXITED_TTL_MS = 60_000;
const TERM_COLS = 120;
const TERM_ROWS = 32;

// ───────────── Process tree and ports (pure) ─────────────

/** `root` and every process below it, given each process's parent. */
export function descendants(root: number, parents: ReadonlyMap<number, number>): Set<number> {
	const children = new Map<number, number[]>();
	for (const [pid, ppid] of parents) {
		const list = children.get(ppid);
		if (list) list.push(pid);
		else children.set(ppid, [pid]);
	}
	const tree = new Set<number>([root]);
	const queue = [root];
	for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
		for (const child of children.get(pid) ?? []) {
			if (tree.has(child)) continue;
			tree.add(child);
			queue.push(child);
		}
	}
	return tree;
}

/** Listening ports, ascending, whose socket some process in `tree` holds. */
export function treePorts(
	tree: ReadonlySet<number>,
	inodesOf: (pid: number) => Iterable<number>,
	listeners: readonly TcpSocket[],
): number[] {
	const inodes = new Set<number>();
	for (const pid of tree) for (const inode of inodesOf(pid)) inodes.add(inode);
	const ports = new Set(listeners.filter((s) => inodes.has(s.inode)).map((s) => s.localPort));
	return [...ports].sort((a, b) => a - b);
}

/** The port to preview among `ports` (ascending): the lowest in the dev range, else the lowest. */
export function pickDevPort(ports: readonly number[]): number | null {
	return ports.find((p) => p < DEV_PORT_MAX) ?? ports[0] ?? null;
}

// ───────────── /proc readers ─────────────

/** Parent pid of every process we can see. */
function readParents(): Map<number, number> {
	const parents = new Map<number, number>();
	let names: string[];
	try {
		names = readdirSync("/proc");
	} catch {
		return parents;
	}
	for (const name of names) {
		if (!/^\d+$/.test(name)) continue;
		const stat = readStat(Number(name));
		if (stat) parents.set(Number(name), stat.ppid);
	}
	return parents;
}

/** State letter and parent pid from /proc/<pid>/stat; the comm field may contain spaces and parentheses. */
function readStat(pid: number): { state: string; ppid: number } | null {
	try {
		const text = readFileSync(`/proc/${pid}/stat`, "utf8");
		const [state = "", ppid = ""] = text.slice(text.lastIndexOf(")") + 2).split(" ");
		return { state, ppid: Number(ppid) };
	} catch {
		return null;
	}
}

function socketInodes(pid: number): number[] {
	const inodes: number[] = [];
	let fds: string[];
	try {
		fds = readdirSync(`/proc/${pid}/fd`);
	} catch {
		return inodes;
	}
	for (const fd of fds) {
		try {
			const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1];
			if (inode) inodes.push(Number(inode));
		} catch {
			// The fd closed while we looked.
		}
	}
	return inodes;
}

/** Alive and not a zombie waiting to be reaped. */
function isAlive(pid: number): boolean {
	const stat = readStat(pid);
	return stat !== null && stat.state !== "Z" && stat.state !== "X";
}

function signal(pid: number, sig: NodeJS.Signals): void {
	try {
		process.kill(pid, sig);
	} catch {
		// Already gone.
	}
}

/**
 * SIGTERMs `root`'s process group and every process below it, then SIGKILLs whatever is left after `graceMs`.
 * The tree is captured first because children are reparented away from `root` once it dies.
 */
export async function killTree(root: number, graceMs = STOP_GRACE_MS): Promise<void> {
	const tree = descendants(root, readParents());
	const send = (sig: NodeJS.Signals) => {
		signal(-root, sig);
		for (const pid of tree) signal(pid, sig);
	};
	send("SIGTERM");
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		if (![...tree].some(isAlive)) return;
		await Bun.sleep(100);
	}
	// Anything started after the snapshot that is still under a survivor goes too.
	const parents = readParents();
	for (const pid of [...tree]) if (isAlive(pid)) for (const child of descendants(pid, parents)) tree.add(child);
	send("SIGKILL");
	for (let i = 0; i < 10 && [...tree].some(isAlive); i++) await Bun.sleep(100);
}

// ───────────── Manager ─────────────

export interface DevServerOptions {
	terms: TerminalManager;
	/** Login shell the command runs under (`<shell> -lc <command>`). */
	shell: string;
	/** The dev command for a confined, real directory; null when it has none. */
	resolve: (cwd: string) => Promise<string | null>;
	/** The gateway's own port, never a dev server's. */
	gatewayPort: number;
	pollMs?: number;
	/** Listening ports, ascending, held by the process tree under `pid`. */
	ports?: (pid: number) => number[];
}

class DevServer {
	readonly id = newId();
	readonly startedAt = Date.now();
	state: DevServerInfo["state"] = "starting";
	port: number | null = null;
	exitCode: number | null = null;
	/** When the tree was first seen listening only on high ports. */
	highSince: number | null = null;
	timer: Timer | undefined;
	constructor(
		readonly cwd: string,
		readonly command: string,
		readonly term: TerminalSession,
	) {}

	info(): DevServerInfo {
		return {
			id: this.id,
			cwd: this.cwd,
			command: this.command,
			termId: this.term.id,
			port: this.port,
			state: this.state,
			exitCode: this.exitCode,
			startedAt: this.startedAt,
		};
	}
}

export class DevServerManager {
	private readonly servers = new Map<string, DevServer>();
	/** Starts resolving their command, by cwd, so a double tap starts one server. */
	private readonly pending = new Map<string, Promise<DevServer>>();
	private readonly pollMs: number;
	private readonly ports: (pid: number) => number[];

	constructor(private readonly opts: DevServerOptions) {
		this.pollMs = opts.pollMs ?? 500;
		this.ports =
			opts.ports ??
			((pid) => {
				const uid = process.getuid?.() ?? -1;
				const listeners = listeningSockets().filter(
					(s) => s.uid === uid && s.scope !== "other" && s.localPort !== opts.gatewayPort,
				);
				if (listeners.length === 0) return [];
				return treePorts(descendants(pid, readParents()), socketInodes, listeners);
			});
	}

	list(): DevServerInfo[] {
		return [...this.servers.values()].map((s) => s.info()).sort((a, b) => a.startedAt - b.startedAt);
	}

	/** Starts the dev command in `cwd` (a confined realpath), or returns the server already running there. */
	async start(cwd: string): Promise<DevServerInfo> {
		const running = this.byCwd(cwd);
		if (running && running.state !== "exited") return running.info();
		let pending = this.pending.get(cwd);
		if (!pending) {
			pending = this.spawn(cwd).finally(() => this.pending.delete(cwd));
			this.pending.set(cwd, pending);
		}
		return (await pending).info();
	}

	/** Stops the server's whole process tree and removes its terminal. False when `id` is unknown. */
	async stop(id: string): Promise<boolean> {
		const server = this.servers.get(id);
		if (!server) return false;
		this.servers.delete(id);
		clearTimeout(server.timer);
		if (server.state !== "exited") await killTree(server.term.pid);
		this.opts.terms.remove(server.term.id);
		return true;
	}

	/** Gateway shutdown: asks every running tree to stop; the terminals' hangup follows. */
	shutdown(): void {
		for (const server of this.servers.values()) {
			clearTimeout(server.timer);
			if (server.state === "exited") continue;
			signal(-server.term.pid, "SIGTERM");
			for (const pid of descendants(server.term.pid, readParents())) signal(pid, "SIGTERM");
		}
	}

	private byCwd(cwd: string): DevServer | undefined {
		for (const server of this.servers.values()) if (server.cwd === cwd) return server;
		return undefined;
	}

	private async spawn(cwd: string): Promise<DevServer> {
		const command = await this.opts.resolve(cwd);
		if (command === null) {
			throw new HttpError(422, "no_dev_command", "No dev command was found for this folder.");
		}
		const previous = this.byCwd(cwd);
		if (previous) this.drop(previous);
		const term = this.opts.terms.create({
			argv: [this.opts.shell, "-lc", command],
			cwd,
			cols: TERM_COLS,
			rows: TERM_ROWS,
			title: `dev · ${basename(cwd)}`,
		});
		const server = new DevServer(cwd, command, term);
		this.servers.set(server.id, server);
		void term.done.then((code) => {
			clearTimeout(server.timer);
			server.state = "exited";
			server.exitCode = code;
			if (this.servers.get(server.id) === server) server.timer = setTimeout(() => this.drop(server), EXITED_TTL_MS);
		});
		this.schedule(server);
		return server;
	}

	private schedule(server: DevServer): void {
		const delay = Date.now() - server.startedAt < FAST_POLL_FOR_MS ? this.pollMs : SLOW_POLL_MS;
		server.timer = setTimeout(() => this.poll(server), delay);
	}

	private poll(server: DevServer): void {
		if (server.state !== "starting") return;
		const port = pickDevPort(this.ports(server.term.pid));
		const now = Date.now();
		if (port !== null && port >= DEV_PORT_MAX) server.highSince ??= now;
		if (port !== null && (port < DEV_PORT_MAX || now - (server.highSince ?? now) >= HIGH_PORT_GRACE_MS)) {
			server.port = port;
			server.state = "ready";
			return;
		}
		this.schedule(server);
	}

	/** Forgets an exited server; its terminal goes too unless a window is showing it. */
	private drop(server: DevServer): void {
		if (this.servers.get(server.id) !== server) return;
		this.servers.delete(server.id);
		clearTimeout(server.timer);
		if (server.term.info().clients === 0) this.opts.terms.remove(server.term.id);
	}
}
