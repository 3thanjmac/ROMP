import fs from "node:fs";
import os from "node:os";
import type { RompEnv } from "./env.ts";
import { RompError } from "./errors.ts";

export interface RunOptions {
	cwd: string;
	env?: Record<string, string>;
	input?: string;
	timeoutMs?: number;
	/** Start in a new session (setsid) so a timeout kills the whole process tree. */
	group?: boolean;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** The parts of a Bun subprocess this module relies on. */
interface Child {
	pid: number;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
}

interface Spawned {
	proc: Child;
	timedOut: () => boolean;
	done: () => void;
}

/** Process groups started with `group`, killed when the service shuts down. */
const liveGroups = new Set<number>();

function spawn(argv: string[], opts: RunOptions): Spawned {
	const proc = Bun.spawn(opts.group ? ["setsid", "-w", ...argv] : argv, {
		cwd: opts.cwd,
		env: opts.env ?? (process.env as Record<string, string>),
		stdin: opts.input === undefined ? "ignore" : new Response(opts.input),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (opts.group) liveGroups.add(proc.pid);
	let timedOut = false;
	const timer = opts.timeoutMs
		? setTimeout(() => {
				timedOut = true;
				killTree(proc.pid, opts.group === true);
			}, opts.timeoutMs)
		: undefined;
	return {
		proc,
		timedOut: () => timedOut,
		done: () => {
			clearTimeout(timer);
			liveGroups.delete(proc.pid);
		},
	};
}

function killTree(pid: number, group: boolean): void {
	for (const target of group ? [-pid, pid] : [pid]) {
		try {
			process.kill(target, "SIGKILL");
		} catch {
			// already gone
		}
	}
}

export function killLiveGroups(): void {
	for (const pid of liveGroups) killTree(pid, true);
	liveGroups.clear();
}

function spawnError(argv: string[], err: unknown): RunResult {
	return { code: 127, stdout: "", stderr: `${argv[0]}: ${(err as Error).message}`, timedOut: false };
}

/** Run a program to completion, capturing stdout and stderr. Never throws for exit status. */
export async function run(argv: string[], opts: RunOptions): Promise<RunResult> {
	let spawned: Spawned;
	try {
		spawned = spawn(argv, opts);
	} catch (err) {
		return spawnError(argv, err);
	}
	const { proc } = spawned;
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	spawned.done();
	return { code, stdout, stderr, timedOut: spawned.timedOut() };
}

export interface ShellResult {
	code: number;
	/** Last `tailBytes` of combined stdout+stderr. */
	output: string;
	timedOut: boolean;
}

export interface ShellOptions {
	cwd: string;
	env?: Record<string, string>;
	timeoutMs: number;
	tailBytes: number;
	/** Append the complete output here. */
	logFile?: string;
}

/** Run `sh -c command` in its own process group with merged output, keeping a bounded tail. */
export async function runShell(command: string, opts: ShellOptions): Promise<ShellResult> {
	const argv = ["sh", "-c", `exec 2>&1\n${command}`];
	let spawned: Spawned;
	try {
		spawned = spawn(argv, { cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs, group: true });
	} catch (err) {
		const failed = spawnError(argv, err);
		return { code: failed.code, output: failed.stderr, timedOut: false };
	}
	const { proc } = spawned;
	const log = opts.logFile ? fs.openSync(opts.logFile, "a", 0o644) : undefined;
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	try {
		for await (const chunk of proc.stdout) {
			if (log !== undefined) fs.writeSync(log, chunk);
			chunks.push(chunk);
			size += chunk.length;
			while (chunks.length > 1 && size - chunks[0]!.length >= opts.tailBytes) {
				size -= chunks.shift()!.length;
				truncated = true;
			}
		}
	} finally {
		if (log !== undefined) fs.closeSync(log);
	}
	await new Response(proc.stderr).arrayBuffer();
	const code = await proc.exited;
	spawned.done();
	const all = Buffer.concat(chunks);
	const kept = all.length > opts.tailBytes ? all.subarray(all.length - opts.tailBytes) : all;
	const text = new TextDecoder().decode(kept);
	return {
		code,
		output: truncated || kept.length < all.length ? `[output truncated]\n${text}` : text,
		timedOut: spawned.timedOut(),
	};
}

/** Variables that would redirect git away from the repository we name explicitly. */
const GIT_LOCATION_VARS: Record<string, true> = {
	GIT_DIR: true,
	GIT_WORK_TREE: true,
	GIT_INDEX_FILE: true,
	GIT_OBJECT_DIRECTORY: true,
	GIT_ALTERNATE_OBJECT_DIRECTORIES: true,
	GIT_COMMON_DIR: true,
	GIT_PREFIX: true,
	GIT_NAMESPACE: true,
	GIT_QUARANTINE_PATH: true,
	GIT_IMPLICIT_WORK_TREE: true,
	GIT_SHALLOW_FILE: true,
	GIT_CONFIG_PARAMETERS: true,
	GIT_CONFIG_COUNT: true,
};

/** Environment for child processes acting for `env.user`. */
export function childEnv(env: RompEnv, extra: Record<string, string> = {}): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || GIT_LOCATION_VARS[key]) continue;
		if (key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) continue;
		out[key] = value;
	}
	out.HOME = env.home;
	// Hub hooks attribute pushes to this user (cooperative trust inside the romp group).
	out.ROMP_USER = env.user;
	return Object.assign(out, extra);
}

export interface GitOptions {
	env?: Record<string, string>;
	input?: string;
	allowFail?: boolean;
	timeoutMs?: number;
}

const GIT_TIMEOUT_MS = 10 * 60_000;

/** Run git in `cwd`. Throws `git_failed` on a non-zero exit unless `allowFail`. */
export async function git(env: RompEnv, cwd: string, args: string[], opts: GitOptions = {}): Promise<RunResult> {
	const result = await run(["git", ...args], {
		cwd,
		input: opts.input,
		timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS,
		env: childEnv(env, {
			GIT_TERMINAL_PROMPT: "0",
			GIT_MERGE_AUTOEDIT: "no",
			GIT_EDITOR: "true",
			LC_ALL: "C",
			...opts.env,
		}),
	});
	if (result.code !== 0 && !opts.allowFail) {
		const detail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-6).join("\n");
		const sub = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c" && args[i - 1] !== "-C") ?? "";
		throw new RompError("git_failed", `git ${sub} failed: ${detail}`);
	}
	return result;
}

/** Trimmed stdout of a git command that must succeed. */
export async function gitOut(env: RompEnv, cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
	return (await git(env, cwd, args, opts)).stdout.trim();
}

/** Resolve a revision to a commit id, or null when it does not exist. */
export async function revParse(env: RompEnv, cwd: string, rev: string): Promise<string | null> {
	const result = await git(env, cwd, ["rev-parse", "-q", "--verify", `${rev}^{commit}`], { allowFail: true });
	return result.code === 0 ? result.stdout.trim() : null;
}

export async function isAncestor(env: RompEnv, cwd: string, ancestor: string, descendant: string): Promise<boolean> {
	const result = await git(env, cwd, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFail: true });
	return result.code === 0;
}

/**
 * Author and committer for commits made on behalf of `env.user`: their git identity,
 * falling back to `<user>@<host>`.
 */
export async function identityEnv(env: RompEnv, cwd: string): Promise<Record<string, string>> {
	const name = (await git(env, cwd, ["config", "user.name"], { allowFail: true })).stdout.trim() || env.user;
	const email =
		(await git(env, cwd, ["config", "user.email"], { allowFail: true })).stdout.trim() || `${env.user}@${os.hostname()}`;
	return {
		GIT_AUTHOR_NAME: name,
		GIT_AUTHOR_EMAIL: email,
		GIT_COMMITTER_NAME: name,
		GIT_COMMITTER_EMAIL: email,
	};
}

/** `-c` arguments that let git touch a group-shared repository owned by another user. */
export const SHARED_REPO_CONFIG = ["-c", "safe.directory=*"];

/** Remote helper commands that bypass git's ownership check on the far side of a local path. */
export const SHARED_UPLOAD_PACK = "git -c safe.directory='*' upload-pack";
export const SHARED_RECEIVE_PACK = "git -c safe.directory='*' receive-pack";
