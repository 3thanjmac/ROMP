/**
 * romp extension for OMP. Active only when the session's cwd is a romp task worktree
 * (`$ROMP_WORK/<repo>/<slug>`):
 * - blocks git commands that change repository state (main session and subagents);
 * - checkpoints after every agent run and hands merge conflicts back to the agent;
 * - `/ship` queues the task for landing;
 * - watches the landing status, reports landed/failed and re-ships after a fixed failure (max 2).
 *
 * Install: symlink this file into `~/.omp/agent/extensions/romp.ts`.
 */
import { fileURLToPath } from "node:url";
import type { LandingState } from "@romp/protocol";
import { type RompEnv, rompEnv, statusFile } from "../src/env.ts";
import { readJsonFile } from "../src/fsutil.ts";
import { findGitWrite, findGitWriteInCode } from "../src/gitguard.ts";
import { taskForPath } from "../src/tasks.ts";

// The subset of OMP's extension API this file uses (see oh-my-pi docs/extensions.md).
type NotifyType = "info" | "warning" | "error";
interface Ctx {
	cwd: string;
	ui: { notify(message: string, type?: NotifyType): void };
	agent?: { kind: "main" | "sub" };
	setInterval(fn: () => void | Promise<void>, ms: number): unknown;
}
interface ToolCallEvent {
	toolName: string;
	input: Record<string, unknown>;
}
interface AgentEndEvent {
	willContinue?: boolean;
}
interface ToolCallResult {
	block?: boolean;
	reason?: string;
}
interface Pi {
	on(event: "tool_call", handler: (event: ToolCallEvent, ctx: Ctx) => ToolCallResult | undefined): void;
	on(event: "agent_end", handler: (event: AgentEndEvent, ctx: Ctx) => Promise<void>): void;
	on(event: "session_start", handler: (event: unknown, ctx: Ctx) => void): void;
	registerCommand(name: string, options: { description: string; handler: (args: string, ctx: Ctx) => Promise<void> }): void;
	sendMessage(
		message: { customType: string; content: string; display: boolean },
		options: { triggerTurn: boolean; deliverAs: "nextTurn" },
	): void;
}

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const CHECKPOINT_WAIT_MS = 25_000;
const POLL_MS = 5_000;
const MAX_RESHIPS = 2;
const MAX_CONFLICT_PROMPTS = 3;

interface RunOutput {
	stdout: string;
	stderr: string;
}

/**
 * Run this tree's romp CLI (same version as the extension) with Bun, fully detached
 * (`setsid -f`) so a checkpoint finishes even when `omp -p` exits right after agent_end.
 * Results come from the `--json` output; the exit status is not observable through the fork.
 */
async function romp(args: string[], cwd: string): Promise<RunOutput> {
	const bun = Bun.which("bun") ?? process.execPath;
	const proc = Bun.spawn(["setsid", "-f", bun, CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	return { stdout, stderr };
}

function parseJson<T>(text: string): T | null {
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

interface CheckpointJson {
	status?: "clean" | "saved" | "conflict";
	conflictFiles?: string[];
	message?: string;
	error?: { message: string };
}

const BLOCK_REASON = (cmd: string) =>
	`Blocked by romp: \`${cmd}\` changes git state, and romp owns git in this task worktree. ` +
	"Just edit files. romp commits, backs up and syncs your work automatically when you finish a turn, " +
	"and lands it when the user ships (/ship). Read-only git (status, diff, log, show, blame) is fine.";

export default function rompExtension(pi: Pi): void {
	const env: RompEnv = rompEnv();
	let conflictPrompts = 0;
	let reships = 0;
	let reshipPending = false;
	let lastSeen = 0;

	const inject = (content: string) =>
		pi.sendMessage({ customType: "romp", content, display: true }, { triggerTurn: true, deliverAs: "nextTurn" });

	const ship = async (ctx: Ctx, message: string | null) => {
		const args = ["ship", ctx.cwd, "--json", ...(message ? ["--message", message] : [])];
		const out = await romp(args, ctx.cwd);
		const parsed = parseJson<{ landing?: LandingState | null; error?: { message: string } }>(out.stdout);
		const ok = parsed !== null && !parsed.error;
		if (ok) ctx.ui.notify(`romp: ${parsed.landing?.message ?? "shipped"}`, "info");
		else ctx.ui.notify(`romp: ship failed: ${parsed?.error?.message ?? out.stderr.trim()}`, "error");
		return ok;
	};

	const handleCheckpoint = (ctx: Ctx, out: RunOutput) => {
		const result = parseJson<CheckpointJson>(out.stdout);
		if (result?.status === "conflict") {
			conflictPrompts++;
			const files = result.conflictFiles ?? [];
			if (conflictPrompts > MAX_CONFLICT_PROMPTS) {
				ctx.ui.notify(`romp: conflicts still unresolved in ${files.join(", ")}`, "warning");
				return;
			}
			inject(
				[
					"romp merged the latest integration branch into this task and some changes conflict.",
					"Resolve the conflict markers (<<<<<<<, =======, >>>>>>>) in these files, keeping the intent of both sides:",
					...files.map((f) => `- ${f}`),
					"Do not run git; romp completes the merge when you finish.",
				].join("\n"),
			);
			return;
		}
		if (!result || result.error) {
			ctx.ui.notify(`romp: checkpoint failed: ${result?.error?.message ?? out.stderr.trim()}`, "error");
			return;
		}
		conflictPrompts = 0;
		if (reshipPending && reships < MAX_RESHIPS) {
			reshipPending = false;
			reships++;
			void ship(ctx, null).catch((err) => ctx.ui.notify(`romp: re-ship failed: ${String(err)}`, "error"));
		}
	};

	const poll = (ctx: Ctx, task: { repo: string; slug: string }) => {
		const landing = readJsonFile<LandingState>(statusFile(env, task.repo, env.user, task.slug));
		if (!landing || landing.updatedAt <= lastSeen) return;
		lastSeen = landing.updatedAt;
		if (landing.state === "landed") {
			reships = 0;
			reshipPending = false;
			ctx.ui.notify(`romp: landed. ${landing.prUrl ?? landing.message}`, "info");
		} else if (landing.state === "failed") {
			ctx.ui.notify(`romp: landing failed: ${landing.message}`, "error");
			reshipPending = reships < MAX_RESHIPS;
			inject(
				[
					`romp could not land this task: ${landing.message}`,
					...(landing.log ? ["", "Output (tail):", "```", landing.log, "```"] : []),
					"",
					reshipPending
						? "Fix the cause in this worktree. When you finish, romp re-ships automatically."
						: "Fix the cause in this worktree, then ask the user to /ship again.",
				].join("\n"),
			);
		}
	};

	pi.on("tool_call", (event, ctx) => {
		if (!taskForPath(env, ctx.cwd)) return undefined;
		const { command, code } = event.input;
		const hit =
			event.toolName === "bash" && typeof command === "string"
				? findGitWrite(command)
				: event.toolName === "eval" && typeof code === "string"
					? findGitWriteInCode(code)
					: null;
		return hit ? { block: true, reason: BLOCK_REASON(hit) } : undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		const task = taskForPath(env, ctx.cwd);
		if (!task || ctx.agent?.kind === "sub") return;
		lastSeen = readJsonFile<LandingState>(statusFile(env, task.repo, env.user, task.slug))?.updatedAt ?? 0;
		ctx.setInterval(() => poll(ctx, task), POLL_MS);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (event.willContinue || ctx.agent?.kind === "sub" || !taskForPath(env, ctx.cwd)) return;
		// Await briefly so print mode does not exit mid-checkpoint; a slow one finishes in the background.
		const run = romp(["checkpoint", ctx.cwd, "--json"], ctx.cwd).then(
			(out) => handleCheckpoint(ctx, out),
			(err) => ctx.ui.notify(`romp: checkpoint failed: ${String(err)}`, "error"),
		);
		await Promise.race([run, Bun.sleep(CHECKPOINT_WAIT_MS)]);
	});

	pi.registerCommand("ship", {
		description: "Queue this romp task for landing (optional argument: commit message)",
		handler: async (args, ctx) => {
			if (!taskForPath(env, ctx.cwd)) {
				ctx.ui.notify("romp: /ship only works inside a romp task worktree", "warning");
				return;
			}
			reships = 0;
			reshipPending = false;
			await ship(ctx, args.trim() || null);
		},
	});
}
