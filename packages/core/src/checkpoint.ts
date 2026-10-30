import fs from "node:fs";
import path from "node:path";
import type { TaskInfo } from "@romp/protocol";
import { cloneDir, landRef, type RompEnv, taskBranch, worktreeDir } from "./env.ts";
import { RompError } from "./errors.ts";
import { headText } from "./fsutil.ts";
import { filesWithMarkers, mergeInProgress, unmergedFiles } from "./merge.ts";
import { childEnv, git, gitOut, identityEnv, isAncestor, revParse, run } from "./proc.ts";
import { ensureClone, type RepoSettings, withRepoLock } from "./repos.ts";
import { readLanding, writeLanding } from "./status.ts";
import { requireMeta, taskInfo, writeMeta } from "./tasks.ts";

export interface CheckpointResult {
	repo: string;
	slug: string;
	/** `clean`: nothing to do. `saved`: committed, pushed and/or synced. `conflict`: markers need resolving. */
	status: "clean" | "saved" | "conflict";
	head: string;
	/** Files that still contain conflict markers (status `conflict`). */
	conflictFiles: string[];
	message: string;
}

/**
 * Save the task: commit everything, back the branch up to the hub, and merge the latest
 * integration branch into it. Never rewrites the task branch. Callers hold the repo lock.
 */
async function checkpointLocked(env: RompEnv, repo: string, slug: string, settings: RepoSettings): Promise<CheckpointResult> {
	const wt = worktreeDir(env, repo, slug);
	if (!fs.existsSync(wt)) throw new RompError("not_found", `Worktree ${wt} is missing`);
	const branch = taskBranch(env, slug);
	const hubRef = `refs/remotes/hub/${settings.branch}`;
	const ident = await identityEnv(env, wt);
	const result = (status: CheckpointResult["status"], head: string, message: string, conflictFiles: string[] = []) => ({
		repo,
		slug,
		status,
		head,
		conflictFiles,
		message,
	});
	let changed = false;

	if (await mergeInProgress(env, wt)) {
		const marked = filesWithMarkers(wt, await unmergedFiles(env, wt));
		if (marked.length > 0) {
			const head = await gitOut(env, wt, ["rev-parse", "HEAD"]);
			return result("conflict", head, `Conflict markers remain in ${marked.length} file(s)`, marked);
		}
		await git(env, wt, ["add", "-A"]);
		await git(env, wt, ["commit", "-q", "--no-verify", "--no-edit"], { env: ident });
		changed = true;
	} else if ((await gitOut(env, wt, ["status", "--porcelain=v1", "-z"])).length > 0) {
		await git(env, wt, ["add", "-A"]);
		await git(env, wt, ["commit", "-q", "--no-verify", "-m", "romp: checkpoint"], { env: ident });
		changed = true;
	}

	const push = async () => {
		const head = await gitOut(env, wt, ["rev-parse", "HEAD"]);
		const remote = await revParse(env, wt, `refs/remotes/hub/${branch}`);
		if (remote === head) return;
		await git(env, wt, [
			"push",
			"-q",
			`--force-with-lease=refs/heads/${branch}:${remote ?? ""}`,
			"hub",
			`HEAD:refs/heads/${branch}`,
		]);
		await git(env, wt, ["update-ref", `refs/remotes/hub/${branch}`, head]);
		changed = true;
	};
	await push();

	/** Merge `ref` into the task; returns a conflict result when it stops on conflicts. */
	const merge = async (ref: string, message: string, strategy: string[] = []) => {
		const out = await git(env, wt, ["merge", "--no-verify", "--no-edit", ...strategy, "-m", message, ref], {
			env: ident,
			allowFail: true,
		});
		changed = true;
		if (out.code === 0) return null;
		if (!(await mergeInProgress(env, wt)))
			throw new RompError("git_failed", `Sync merge failed: ${(out.stderr || out.stdout).trim()}`);
		const files = await unmergedFiles(env, wt);
		const head = await gitOut(env, wt, ["rev-parse", "HEAD"]);
		const marked = filesWithMarkers(wt, files);
		return result(
			"conflict",
			head,
			`Merging ${settings.branch} stopped on conflicts in ${files.length} file(s)`,
			marked.length > 0 ? marked : files,
		);
	};

	// A landed squash carries this task's own changes; record it as merged (after merging what it
	// was built on) so later syncs do not replay the task's work against itself as conflicts.
	const landed = readLanding(env, repo, env.user, slug);
	const landedCommit = landed?.state === "landed" ? landed.commit : null;
	if (
		landedCommit &&
		(await isAncestor(env, wt, landedCommit, hubRef)) &&
		!(await isAncestor(env, wt, landedCommit, "HEAD"))
	) {
		const parent = `${landedCommit}^`;
		if (!(await isAncestor(env, wt, parent, "HEAD"))) {
			const conflict = await merge(parent, `romp: sync ${settings.branch}`);
			if (conflict) return conflict;
		}
		const conflict = await merge(landedCommit, `romp: record landing of ${landedCommit.slice(0, 12)}`, ["-s", "ours"]);
		if (conflict) return conflict;
	}

	if (!(await isAncestor(env, wt, hubRef, "HEAD"))) {
		const conflict = await merge(hubRef, `romp: sync ${settings.branch}`);
		if (conflict) return conflict;
	}
	await push();
	const head = await gitOut(env, wt, ["rev-parse", "HEAD"]);
	return result(changed ? "saved" : "clean", head, changed ? "Checkpoint saved" : "Nothing to save");
}

export async function checkpoint(env: RompEnv, repo: string, slug: string): Promise<CheckpointResult> {
	requireMeta(env, repo, slug);
	return withRepoLock(env, repo, async () => checkpointLocked(env, repo, slug, await ensureClone(env, repo)));
}

/** The omp binary for `env.user`, if installed. */
export function findOmp(env: RompEnv): string | null {
	const onPath = Bun.which("omp");
	if (onPath) return onPath;
	const local = path.join(env.home, ".bun", "bin", "omp");
	return fs.existsSync(local) ? local : null;
}

const MESSAGE_TIMEOUT_MS = 90_000;
const MESSAGE_DIFF_BYTES = 12 * 1024;

/** Ask `omp -p` for a commit message describing `diff`; null when omp is missing, slow or unhelpful. */
async function generateMessage(env: RompEnv, cwd: string, title: string, diff: string): Promise<string | null> {
	const omp = findOmp(env);
	if (!omp) return null;
	const prompt = [
		"Write a git commit message for the change below. Reply with only the message:",
		"a subject line of at most 72 characters in the imperative mood, optionally a blank line and a short body.",
		"No code fences, no quotes, no preamble.",
		`Task title: ${title}`,
		"",
		headText(diff, MESSAGE_DIFF_BYTES),
	].join("\n");
	const out = await run(
		[omp, "-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-title", prompt],
		{ cwd, env: childEnv(env), timeoutMs: MESSAGE_TIMEOUT_MS, group: true },
	);
	if (out.code !== 0 || out.timedOut) return null;
	const text = out.stdout
		.split("\n")
		.filter((line) => !line.trim().startsWith("```"))
		.join("\n")
		.trim();
	if (!text || text.length > 4000) return null;
	const [subject = "", ...body] = text.split("\n");
	const cleanSubject = subject.replace(/^["'`]+|["'`]+$/g, "").trim();
	return cleanSubject ? [cleanSubject, ...body].join("\n").trim() : null;
}

/**
 * Squash the task's net change onto the hub integration branch and push it as
 * `land/<user>/<slug>`; the hub's post-receive hook queues it for landing.
 */
export async function shipTask(env: RompEnv, repo: string, slug: string, opts: { message?: string } = {}): Promise<TaskInfo> {
	const meta = requireMeta(env, repo, slug);
	return withRepoLock(env, repo, async () => {
		const settings = await ensureClone(env, repo);
		const saved = await checkpointLocked(env, repo, slug, settings);
		if (saved.status === "conflict")
			throw new RompError("conflict", `Resolve conflicts before shipping: ${saved.conflictFiles.join(", ")}`);
		const wt = worktreeDir(env, repo, slug);
		const hubRef = `refs/remotes/hub/${settings.branch}`;
		const diff = await gitOut(env, wt, ["diff", "--stat", "--patch", hubRef, "HEAD"]);
		if (!diff) throw new RompError("bad_request", `Nothing to ship: ${repo}/${slug} has no changes against ${settings.branch}`);
		const message = opts.message?.trim() || (await generateMessage(env, wt, meta.title, diff)) || meta.title;
		const ident = await identityEnv(env, wt);
		const squash = await gitOut(env, wt, ["commit-tree", "HEAD^{tree}", "-p", hubRef, "-F", "-"], {
			env: ident,
			input: `${message}\n`,
		});
		writeLanding(env, repo, env.user, slug, { state: "queued", message: `Queued for ${settings.branch}`, commit: squash });
		try {
			await git(env, cloneDir(env, repo), ["push", "-q", "--force", "hub", `${squash}:${landRef(env.user, slug)}`]);
		} catch (err) {
			writeLanding(env, repo, env.user, slug, { state: "failed", message: `Ship failed: ${(err as Error).message}` });
			throw err;
		}
		writeMeta(env, repo, slug, { ...meta, shippedHead: saved.head });
		return taskInfo(env, repo, slug, settings);
	});
}
