import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	hubDir,
	isRepoName,
	isSlug,
	landRef,
	queueDir,
	queueUser,
	type RompEnv,
	repoLogsDir,
	workDir,
} from "./env.ts";
import { ensureDir, readJsonFile, SHARED_DIR_MODE, tailText, tryWithLock, writeFileAtomic } from "./fsutil.ts";
import { LandError, landCommit } from "./land.ts";
import { configureHubRemote, isLocalUrl, readSettings, repoNames, type RepoSettings } from "./repos.ts";
import { git, gitOut, revParse } from "./proc.ts";
import { queueLock, writeLanding } from "./status.ts";

export interface Job {
	repo: string;
	user: string;
	slug: string;
	commit: string;
	enqueuedAt: number;
}

const ZERO = /^0+$/;
const LAND_RE = /^refs\/heads\/land\/([^/]+)\/([^/]+)$/;
const AGENT_RE = /^refs\/heads\/agent\/([^/]+)\/.+$/;

/** The account a hub hook acts for: `ROMP_USER` (set by romp's own git calls) or the OS user. */
const pusher = () => process.env.ROMP_USER || os.userInfo().username;

interface RefUpdate {
	oldSha: string;
	newSha: string;
	ref: string;
}

function parseHookInput(text: string): RefUpdate[] {
	return text
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter((parts) => parts.length === 3)
		.map(([oldSha, newSha, ref]) => ({ oldSha: oldSha!, newSha: newSha!, ref: ref! }));
}

/** Hub `pre-receive`: users may only write their own `agent/<user>/*` and `land/<user>/*` refs. */
export function preReceive(input: string): string[] {
	const who = pusher();
	if (who === queueUser()) return [];
	const errors: string[] = [];
	for (const { ref } of parseHookInput(input)) {
		const own = LAND_RE.exec(ref)?.[1] ?? AGENT_RE.exec(ref)?.[1];
		if (own !== who)
			errors.push(`romp: ${who} may only push refs/heads/agent/${who}/* and refs/heads/land/${who}/* (rejected ${ref})`);
	}
	return errors;
}

/** Hub `post-receive` (cwd = hub repo): atomically enqueue every pushed `land/<user>/<slug>`. */
export function postReceive(gitDir: string, input: string): Job[] {
	const hub = path.resolve(gitDir);
	const repo = path.basename(hub).replace(/\.git$/, "");
	const root = path.dirname(path.dirname(hub));
	const jobs: Job[] = [];
	for (const { newSha, ref } of parseHookInput(input)) {
		const match = LAND_RE.exec(ref);
		if (!match || ZERO.test(newSha)) continue;
		const [, user, slug] = match;
		if (!isSlug(slug!) || !isRepoName(repo)) continue;
		const job: Job = { repo, user: user!, slug: slug!, commit: newSha, enqueuedAt: Date.now() };
		const name = `${job.enqueuedAt}-${process.pid}-${jobs.length}.json`;
		writeFileAtomic(path.join(root, "queue", "incoming", name), `${JSON.stringify(job)}\n`);
		jobs.push(job);
	}
	return jobs;
}

function listJobs(env: RompEnv, state: "incoming" | "processing"): { file: string; job: Job }[] {
	let names: string[];
	try {
		names = fs.readdirSync(queueDir(env, state));
	} catch {
		return [];
	}
	const out: { file: string; job: Job }[] = [];
	for (const name of names.sort()) {
		if (name.startsWith(".") || !name.endsWith(".json")) continue;
		const file = path.join(queueDir(env, state), name);
		try {
			const job = readJsonFile<Job>(file);
			if (job && isRepoName(job.repo)) out.push({ file, job });
		} catch {
			// a corrupt job is moved aside below by the claimer of its repo
			out.push({ file, job: { repo: "", user: "", slug: "", commit: "", enqueuedAt: 0 } });
		}
	}
	return out;
}

function moveJob(file: string, dir: string): string | null {
	const dest = path.join(dir, path.basename(file));
	try {
		fs.renameSync(file, dest);
		return dest;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

/** The queue's clone of a hub repo in `$ROMP_ROOT/work/<repo>`, with `origin` = hub and `upstream` = remote. */
async function ensureWork(env: RompEnv, repo: string, settings: RepoSettings): Promise<string> {
	const work = workDir(env, repo);
	if (!fs.existsSync(path.join(work, ".git"))) {
		fs.rmSync(work, { recursive: true, force: true });
		ensureDir(work);
		await git(env, work, ["init", "-q", `--initial-branch=romp-work`]);
		await configureHubRemote(env, work, "origin", hubDir(env, repo));
	}
	for (const key of ["url", "uploadpack", "receivepack"])
		await git(env, work, ["config", "--local", "--unset-all", `remote.upstream.${key}`], { allowFail: true });
	if (settings.remote && isLocalUrl(settings.remote)) await configureHubRemote(env, work, "upstream", settings.remote);
	else if (settings.remote) await git(env, work, ["config", "--local", "remote.upstream.url", settings.remote]);
	return work;
}

/** Bring the hub integration branch up to date with upstream. Upstream wins when they diverged. */
export async function syncUpstream(env: RompEnv, work: string, settings: RepoSettings, log: (line: string) => void) {
	const b = settings.branch;
	await git(env, work, ["fetch", "-q", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`]);
	if (!settings.remote) return;
	await git(env, work, ["fetch", "-q", "upstream", `+refs/heads/${b}:refs/remotes/upstream/${b}`], {
		timeoutMs: 10 * 60_000,
	});
	const hub = await revParse(env, work, `refs/remotes/origin/${b}`);
	const up = await revParse(env, work, `refs/remotes/upstream/${b}`);
	if (!up || hub === up) return;
	if (hub && (await git(env, work, ["merge-base", "--is-ancestor", up, hub], { allowFail: true })).code === 0) return;
	if (hub && (await git(env, work, ["merge-base", "--is-ancestor", hub, up], { allowFail: true })).code !== 0)
		log(`warning: hub ${b} diverged from upstream; resetting hub ${b} to upstream ${up.slice(0, 12)}`);
	await git(env, work, ["push", "-q", `--force-with-lease=refs/heads/${b}:${hub ?? ""}`, "origin", `${up}:refs/heads/${b}`]);
	await git(env, work, ["update-ref", `refs/remotes/origin/${b}`, up]);
}

const LOG_TAIL = 16 * 1024;

async function processJob(env: RompEnv, job: Job): Promise<"landed" | "failed" | "skipped"> {
	const ref = landRef(job.user, job.slug);
	let settings: RepoSettings;
	try {
		settings = readSettings(env, job.repo);
	} catch {
		return "skipped";
	}
	const work = await ensureWork(env, job.repo, settings);
	const current = (await gitOut(env, work, ["ls-remote", "origin", ref])).split(/\s/)[0] ?? "";
	// Missing: already handled by an earlier job for the same ref, or the task was removed.
	if (!current) return "skipped";
	const logDir = repoLogsDir(env, job.repo);
	ensureDir(logDir, SHARED_DIR_MODE);
	const logFile = path.join(logDir, `${job.user}--${job.slug}.log`);
	fs.writeFileSync(logFile, `romp landing ${job.repo} ${job.user}/${job.slug} ${current} at ${new Date().toISOString()}\n`, {
		mode: 0o664,
	});
	const log = (line: string) => fs.appendFileSync(logFile, `${line}\n`);
	writeLanding(env, job.repo, job.user, job.slug, { state: "landing", message: "Landing", commit: current });
	const deleteRef = () =>
		git(env, work, ["push", "-q", `--force-with-lease=${ref}:${current}`, "origin", `:${ref}`], { allowFail: true });
	try {
		await git(env, work, ["fetch", "-q", "origin", `+${ref}:refs/romp/land`]);
		const landed = await landCommit(env, { work, settings, job, landSha: current, logFile, log, sync: syncUpstream });
		await deleteRef();
		writeLanding(env, job.repo, job.user, job.slug, {
			state: "landed",
			message: landed.message,
			commit: landed.commit,
			prUrl: landed.prUrl,
		});
		log(`landed: ${landed.message}`);
		return "landed";
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const detail = err instanceof LandError ? err.log : null;
		log(`failed: ${message}`);
		await deleteRef();
		writeLanding(env, job.repo, job.user, job.slug, {
			state: "failed",
			message: message.split("\n")[0]!.slice(0, 300),
			log: tailText(detail ?? message, LOG_TAIL),
		});
		return "failed";
	}
}

/**
 * Land every queued job of one repo, oldest first, holding the repo's queue lock.
 * Jobs left in `processing/` by a crashed run are retried before new ones.
 */
async function drainRepo(env: RompEnv, repo: string): Promise<number> {
	ensureDir(path.join(env.root, "work"), SHARED_DIR_MODE);
	const result = await tryWithLock(queueLock(env, repo), async () => {
		let handled = 0;
		for (;;) {
			let claimed = listJobs(env, "processing").find((j) => j.job.repo === repo)?.file ?? null;
			if (!claimed) {
				const next = listJobs(env, "incoming").find((j) => j.job.repo === repo);
				if (!next) break;
				claimed = moveJob(next.file, queueDir(env, "processing"));
				if (!claimed) continue;
			}
			const job = readJsonFile<Job>(claimed)!;
			const outcome = await processJob(env, job);
			moveJob(claimed, queueDir(env, outcome === "failed" ? "failed" : "done"));
			handled++;
		}
		return handled;
	});
	return result ?? 0;
}

/** Move unparseable job files aside so they do not block the queue. */
function quarantineCorrupt(env: RompEnv): void {
	for (const state of ["incoming", "processing"] as const)
		for (const { file, job } of listJobs(env, state)) if (!job.repo) moveJob(file, queueDir(env, "failed"));
}

/** Process everything currently queued. Repos run concurrently; each repo is strictly serial. */
export async function runOnce(env: RompEnv): Promise<number> {
	quarantineCorrupt(env);
	const repos = new Set([...listJobs(env, "processing"), ...listJobs(env, "incoming")].map((j) => j.job.repo));
	const counts = await Promise.all([...repos].map((repo) => drainRepo(env, repo)));
	return counts.reduce((a, b) => a + b, 0);
}

/** Sync every repo that has an upstream into its hub branch (skips repos busy landing). */
export async function syncAll(env: RompEnv, log: (line: string) => void): Promise<void> {
	for (const repo of repoNames(env)) {
		try {
			const settings = readSettings(env, repo);
			if (!settings.remote) continue;
			await tryWithLock(queueLock(env, repo), async () => {
				const work = await ensureWork(env, repo, settings);
				await syncUpstream(env, work, settings, log);
			});
		} catch (err) {
			log(`sync ${repo}: ${(err as Error).message}`);
		}
	}
}

const POLL_MS = 2_000;
const SYNC_MS = 60_000;

/** Long-running queue service: drain the queue continuously and sync upstreams every minute. */
export async function serve(env: RompEnv, log: (line: string) => void, signal: AbortSignal): Promise<void> {
	let lastSync = 0;
	while (!signal.aborted) {
		try {
			if (Date.now() - lastSync >= SYNC_MS) {
				lastSync = Date.now();
				await syncAll(env, log);
			}
			const handled = await runOnce(env);
			if (handled > 0) log(`processed ${handled} job(s)`);
		} catch (err) {
			log(`queue error: ${(err as Error).message}`);
		}
		await Bun.sleep(POLL_MS);
	}
}
