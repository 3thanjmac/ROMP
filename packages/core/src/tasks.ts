import fs from "node:fs";
import path from "node:path";
import type { TaskInfo, TaskStatus } from "@romp/protocol";
import {
	cloneDir,
	hubDir,
	isRepoName,
	isSlug,
	landRef,
	repoEnvFile,
	repoLogsDir,
	type RompEnv,
	settingsFile,
	statusDir,
	statusFile,
	taskBranch,
	taskMetaDir,
	workDir,
	worktreeDir,
} from "./env.ts";
import { RompError } from "./errors.ts";
import { ensureDir, readJsonFile, writeFileAtomic } from "./fsutil.ts";
import { filesWithMarkers, mergeInProgress, unmergedFiles } from "./merge.ts";
import { git, gitOut, revParse } from "./proc.ts";
import {
	cloneRefspecs,
	copyRepoEnv,
	ensureClone,
	hubGit,
	type RepoSettings,
	readSettings,
	requireHubWritable,
	taskSlugs,
	withQueueIdle,
	withRepoLock,
} from "./repos.ts";
import { readLanding } from "./status.ts";

/** Per-task bookkeeping in `~/romp/<repo>.git/romp/<slug>.json`. */
export interface TaskMeta {
	title: string;
	createdAt: number;
	/** Task HEAD when it was last shipped; lets `landed`/`failed` give way to `active` on new work. */
	shippedHead: string | null;
}

const metaFile = (env: RompEnv, repo: string, slug: string) => path.join(taskMetaDir(env, repo), `${slug}.json`);

export function readMeta(env: RompEnv, repo: string, slug: string): TaskMeta | null {
	return readJsonFile<TaskMeta>(metaFile(env, repo, slug));
}

export function writeMeta(env: RompEnv, repo: string, slug: string, meta: TaskMeta): void {
	ensureDir(taskMetaDir(env, repo));
	writeFileAtomic(metaFile(env, repo, slug), `${JSON.stringify(meta, null, "\t")}\n`, 0o644);
}

export function requireMeta(env: RompEnv, repo: string, slug: string): TaskMeta {
	if (!isRepoName(repo) || !isSlug(slug)) throw new RompError("bad_request", `Invalid task: ${repo}/${slug}`);
	const meta = readMeta(env, repo, slug);
	if (!meta) throw new RompError("not_found", `Unknown task: ${repo}/${slug}`);
	return meta;
}

function realpathOr(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}

/** The task whose worktree contains `absPath`, or null. */
export function taskForPath(env: RompEnv, absPath: string): { repo: string; slug: string } | null {
	const roots = [path.resolve(env.workRoot), realpathOr(env.workRoot)];
	const targets = [path.resolve(absPath), realpathOr(absPath)];
	for (const root of roots) {
		for (const target of targets) {
			const rel = path.relative(root, target);
			if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
			const [repo, slug] = rel.split(path.sep);
			if (repo && slug && isRepoName(repo) && isSlug(slug) && fs.existsSync(metaFile(env, repo, slug)))
				return { repo, slug };
		}
	}
	return null;
}

export function slugify(title: string): string {
	return title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
}

export async function createTask(
	env: RompEnv,
	input: { repo: string; title: string; slug?: string },
): Promise<TaskInfo> {
	const { repo } = input;
	const title = input.title.trim();
	if (!title) throw new RompError("bad_request", "A task needs a title");
	readSettings(env, repo);
	if (input.slug !== undefined && !isSlug(input.slug)) throw new RompError("bad_request", `Invalid slug: ${input.slug}`);
	return withRepoLock(env, repo, async () => {
		const settings = await ensureClone(env, repo);
		const taken = (slug: string) => readMeta(env, repo, slug) !== null || fs.existsSync(worktreeDir(env, repo, slug));
		let slug = input.slug ?? (slugify(title) || "task");
		if (taken(slug)) {
			if (input.slug !== undefined) throw new RompError("conflict", `Task ${repo}/${slug} already exists`);
			const base = slug.slice(0, 36);
			let n = 2;
			while (taken(`${base}-${n}`)) n++;
			slug = `${base}-${n}`;
		}
		const clone = cloneDir(env, repo);
		const branch = taskBranch(env, slug);
		if (await revParse(env, clone, `refs/heads/${branch}`))
			throw new RompError("conflict", `Branch ${branch} already exists in ${clone}`);
		ensureDir(path.join(env.workRoot, repo));
		await git(env, clone, [
			"worktree",
			"add",
			"-q",
			"--no-track",
			"-b",
			branch,
			worktreeDir(env, repo, slug),
			`refs/remotes/hub/${settings.branch}`,
		]);
		writeMeta(env, repo, slug, { title, createdAt: Date.now(), shippedHead: null });
		copyRepoEnv(env, repo, worktreeDir(env, repo, slug));
		return taskInfo(env, repo, slug, settings);
	});
}

/** Live state of one task, derived from its worktree, the hub branch and the landing status file. */
export async function taskInfo(env: RompEnv, repo: string, slug: string, settings: RepoSettings): Promise<TaskInfo> {
	const meta = requireMeta(env, repo, slug);
	const wt = worktreeDir(env, repo, slug);
	const branch = taskBranch(env, slug);
	const landing = readLanding(env, repo, env.user, slug);
	const base: TaskInfo = {
		repo,
		slug,
		branch,
		path: wt,
		title: meta.title,
		createdAt: meta.createdAt,
		status: "active",
		dirty: false,
		ahead: 0,
		behind: 0,
		conflictFiles: [],
		landing,
	};
	if (!fs.existsSync(wt)) return base;
	const hubRef = `refs/remotes/hub/${settings.branch}`;
	const porcelain = await gitOut(env, wt, ["status", "--porcelain=v1", "-z"]);
	const dirty = porcelain.length > 0;
	const merging = await mergeInProgress(env, wt);
	const conflictFiles = merging ? filesWithMarkers(wt, await unmergedFiles(env, wt)) : [];
	const counts = await git(env, wt, ["rev-list", "--left-right", "--count", `${hubRef}...HEAD`], { allowFail: true });
	const [behind = 0, ahead = 0] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [];
	// Commits stay "ahead" after a squash landing; only count them while there is a net diff.
	const sameTree = (await git(env, wt, ["diff", "--quiet", hubRef, "HEAD"], { allowFail: true })).code === 0;
	const head = await revParse(env, wt, "HEAD");
	let status: TaskStatus = "active";
	if (merging) status = "conflict";
	else if (landing?.state === "queued" || landing?.state === "landing") status = landing.state;
	else if (landing && !dirty && (head === meta.shippedHead || sameTree)) status = landing.state;
	return {
		...base,
		status,
		dirty,
		ahead: sameTree ? 0 : ahead,
		behind,
		conflictFiles,
	};
}

/** All of this user's tasks across repos. Fetches each repo's hub once so ahead/behind are current. */
export async function listTasks(env: RompEnv): Promise<TaskInfo[]> {
	let entries: string[];
	try {
		entries = fs.readdirSync(env.workRoot);
	} catch {
		return [];
	}
	const out: TaskInfo[] = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".git")) continue;
		const repo = entry.slice(0, -4);
		if (!isRepoName(repo)) continue;
		let settings: RepoSettings;
		try {
			settings = readSettings(env, repo);
		} catch {
			continue;
		}
		const slugs = taskSlugs(env, repo);
		if (slugs.length === 0) continue;
		// Explicit refspecs: the clone's configured ones still name the old branch until `ensureClone` runs after a switch.
		await git(env, cloneDir(env, repo), ["fetch", "--prune", "-q", "hub", ...cloneRefspecs(env, settings.branch)], {
			allowFail: true,
		});
		const infos = await Promise.all(
			slugs.map((slug) =>
				taskInfo(env, repo, slug, settings).catch((err: unknown) => {
					// The repo or task was removed while listing.
					if (!fs.existsSync(settingsFile(env, repo)) || readMeta(env, repo, slug) === null) return null;
					throw err;
				}),
			),
		);
		out.push(...infos.filter((t) => t !== null).sort((a, b) => a.createdAt - b.createdAt));
	}
	return out;
}

export async function getTask(env: RompEnv, repo: string, slug: string): Promise<TaskInfo> {
	requireMeta(env, repo, slug);
	return taskInfo(env, repo, slug, readSettings(env, repo));
}

/** Change a task's title; its slug and branch keep the name they were created with. */
export async function renameTask(env: RompEnv, repo: string, slug: string, title: string): Promise<void> {
	requireMeta(env, repo, slug);
	const trimmed = title.trim();
	if (!trimmed) throw new RompError("bad_request", "A task needs a title");
	await withRepoLock(env, repo, async () => {
		const meta = requireMeta(env, repo, slug);
		writeMeta(env, repo, slug, { ...meta, title: trimmed });
	});
}

/** Remove the worktree, the local and hub task branches, any pending landing and the status file. */
export async function removeTask(env: RompEnv, repo: string, slug: string): Promise<void> {
	requireMeta(env, repo, slug);
	if (readLanding(env, repo, env.user, slug)?.state === "landing")
		throw new RompError("conflict", `Task ${repo}/${slug} is being landed right now; try again when it finishes`);
	await withRepoLock(env, repo, async () => {
		const clone = cloneDir(env, repo);
		const wt = worktreeDir(env, repo, slug);
		const branch = taskBranch(env, slug);
		const removed = await git(env, clone, ["worktree", "remove", "--force", "--force", wt], { allowFail: true });
		if (removed.code !== 0) {
			fs.rmSync(wt, { recursive: true, force: true });
			await git(env, clone, ["worktree", "prune"]);
		}
		await git(env, clone, ["branch", "-D", branch], { allowFail: true });
		await git(env, clone, ["push", "-q", "hub", "--delete", `refs/heads/${branch}`, landRef(env.user, slug)], {
			allowFail: true,
		});
		await git(env, clone, ["update-ref", "-d", `refs/remotes/hub/${branch}`], { allowFail: true });
		fs.rmSync(statusFile(env, repo, env.user, slug), { force: true });
		fs.rmSync(metaFile(env, repo, slug), { force: true });
	});
}

/** Users other than `env.user` with task branches (`agent/<user>/...`) in the repo's hub. */
async function otherTaskOwners(env: RompEnv, name: string): Promise<string[]> {
	const out = await hubGit(env, name, ["for-each-ref", "--format=%(refname)", "refs/heads/agent/"]);
	const users = new Set<string>();
	for (const ref of out.stdout.split("\n")) {
		const user = ref.split("/")[3];
		if (user && user !== env.user) users.add(user);
	}
	return [...users].sort();
}

/**
 * Delete a repo for everyone. Refused while another user has task branches in the hub or a landing is pending.
 * Removes this user's tasks, clone, worktrees and `.env`, then the hub, settings, status, queue work dir and logs.
 * Returns the slugs of the removed tasks.
 */
export async function removeRepo(env: RompEnv, name: string): Promise<string[]> {
	readSettings(env, name);
	requireHubWritable(env);
	const slugs = taskSlugs(env, name);
	await withQueueIdle(env, name, "removing it", async () => {
		const owners = await otherTaskOwners(env, name);
		if (owners.length > 0)
			throw new RompError("conflict", `${owners.join(", ")} still ${owners.length === 1 ? "has" : "have"} tasks in ${name}`);
		for (const slug of slugs) await removeTask(env, name, slug);
		await withRepoLock(env, name, async () => {
			fs.rmSync(cloneDir(env, name), { recursive: true, force: true });
			fs.rmSync(path.join(env.workRoot, name), { recursive: true, force: true });
		});
		fs.rmSync(repoEnvFile(env, name), { force: true });
		// Out of the way in one step, so a failed delete below leaves no half-removed hub behind.
		const doomed = path.join(env.root, "hub", `.removed-${name}-${process.pid}-${Date.now()}`);
		if (fs.existsSync(hubDir(env, name))) fs.renameSync(hubDir(env, name), doomed);
		fs.rmSync(settingsFile(env, name), { force: true });
		for (const dir of [statusDir(env, name), workDir(env, name), repoLogsDir(env, name), doomed])
			fs.rmSync(dir, { recursive: true, force: true });
	});
	return slugs;
}
