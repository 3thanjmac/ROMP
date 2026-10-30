import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";
import { errnoCode } from "./util.ts";

/** TCP sockets as listed in /proc/net/tcp{,6}. IPv4-mapped IPv6 addresses are reported as IPv4. */
export interface TcpSocket {
	family: 4 | 6;
	address: string;
	scope: "loopback" | "any" | "other";
	localPort: number;
	remotePort: number;
	state: number;
	uid: number;
	inode: number;
}

export const TCP_TIME_WAIT = 0x06;
export const TCP_CLOSE = 0x07;
export const TCP_LISTEN = 0x0a;

export function parseProcNetTcp(text: string, v6: boolean): TcpSocket[] {
	const sockets: TcpSocket[] = [];
	for (const line of text.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 10 || !fields[0]?.endsWith(":")) continue;
		const local = splitEndpoint(fields[1] ?? "");
		const remote = splitEndpoint(fields[2] ?? "");
		if (!local || !remote) continue;
		sockets.push({
			...decodeAddress(local.hex, v6),
			localPort: local.port,
			remotePort: remote.port,
			state: Number.parseInt(fields[3] ?? "", 16),
			uid: Number(fields[7]),
			inode: Number(fields[9]),
		});
	}
	return sockets;
}

function splitEndpoint(endpoint: string): { hex: string; port: number } | null {
	const match = /^([0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}):([0-9A-Fa-f]{4})$/.exec(endpoint);
	return match ? { hex: match[1] ?? "", port: Number.parseInt(match[2] ?? "", 16) } : null;
}

/** /proc prints each 32-bit word of the address in host (little-endian) byte order. */
function decodeAddress(hex: string, v6: boolean): Pick<TcpSocket, "family" | "address" | "scope"> {
	const bytes: number[] = [];
	for (let word = 0; word < hex.length; word += 8) {
		for (let i = 6; i >= 0; i -= 2) bytes.push(Number.parseInt(hex.slice(word + i, word + i + 2), 16));
	}
	if (!v6) return ipv4(bytes);
	const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
	if (mapped) return ipv4(bytes.slice(12));
	const unspecified = bytes.every((b) => b === 0);
	const loopback = bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1;
	const groups: string[] = [];
	for (let i = 0; i < 16; i += 2) groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16));
	return {
		family: 6,
		address: unspecified ? "::" : loopback ? "::1" : groups.join(":"),
		scope: unspecified ? "any" : loopback ? "loopback" : "other",
	};
}

function ipv4(bytes: number[]): Pick<TcpSocket, "family" | "address" | "scope"> {
	return {
		family: 4,
		address: bytes.join("."),
		scope: bytes[0] === 127 ? "loopback" : bytes.every((b) => b === 0) ? "any" : "other",
	};
}

export function readTcpSockets(): TcpSocket[] {
	const sockets = parseProcNetTcp(readFileSync("/proc/net/tcp", "utf8"), false);
	try {
		sockets.push(...parseProcNetTcp(readFileSync("/proc/net/tcp6", "utf8"), true));
	} catch (err) {
		if (errnoCode(err) !== "ENOENT") throw err;
	}
	return sockets;
}

export function listeningSockets(): TcpSocket[] {
	return readTcpSockets().filter((socket) => socket.state === TCP_LISTEN);
}

/**
 * uids owning the client end of a loopback connection to `serverPort` from `peerPort`. Used to tell
 * `tailscale serve` (tailscaled runs as root) apart from other local users talking to the listener.
 */
export function peerUids(peerPort: number, serverPort: number): number[] {
	return readTcpSockets()
		.filter(
			(s) =>
				s.localPort === peerPort &&
				s.remotePort === serverPort &&
				s.state !== TCP_TIME_WAIT &&
				s.state !== TCP_CLOSE,
		)
		.map((s) => s.uid);
}

const RUNTIMES = /^(node|bun|deno|python[\d.]*|ruby|java|php)$/;
const INLINE_CODE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c"]);
/** Interpreter flags whose next argument is a value, not the script. */
const VALUE_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--env-file", "--cwd", "--config"]);

/** A short human name for a process: the script name for interpreters (`vite`, `http.server`), else `comm`. */
export function describeProcess(argv: readonly string[], comm: string): string {
	if (!RUNTIMES.test(comm)) return comm;
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "-m" && argv[i + 1]) return argv[i + 1] ?? comm;
		// Inline code (`node -e`, `python -c`, ...) has no script name worth showing.
		if (INLINE_CODE_FLAGS.has(arg)) return comm;
		if (VALUE_FLAGS.has(arg)) {
			i++;
			continue;
		}
		if (arg.startsWith("-") || arg === "run" || arg === "x" || arg === "exec") continue;
		return basename(arg).replace(/\.(c|m)?(j|t)s$|\.py$/, "");
	}
	return comm;
}

/** Maps socket inodes to the name of a process holding them. Only processes we may inspect are scanned. */
export function socketProcessNames(inodes: ReadonlySet<number>): Map<number, string> {
	const names = new Map<number, string>();
	if (inodes.size === 0) return names;
	let pids: string[];
	try {
		pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
	} catch {
		return names;
	}
	for (const pid of pids) {
		let fds: string[];
		try {
			fds = readdirSync(`/proc/${pid}/fd`);
		} catch {
			continue;
		}
		for (const fd of fds) {
			let link: string;
			try {
				link = readlinkSync(`/proc/${pid}/fd/${fd}`);
			} catch {
				continue;
			}
			const inode = Number(/^socket:\[(\d+)\]$/.exec(link)?.[1]);
			if (!inodes.has(inode) || names.has(inode)) continue;
			names.set(inode, processName(pid));
			if (names.size === inodes.size) return names;
		}
	}
	return names;
}

function processName(pid: string): string {
	let comm = "";
	try {
		comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
		const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
		return describeProcess(argv, comm);
	} catch {
		return comm;
	}
}
