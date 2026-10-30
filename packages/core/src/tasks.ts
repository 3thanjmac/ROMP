import fs from "node:fs";
import path from "node:path";
import type { TaskInfo, TaskStatus } from "@romp/protocol";
import {
	cloneDir,
	isRepoName,
	isSlug,
	landRef,
	type RompEnv,
	statusFile,
	taskBranch,
	taskMetaDir,
	worktreeDir,
} from "./env.ts";
import { RompError } from "./errors.ts";
import { ensureDir, readJsonFile, writeFileAtomic } from "./fsutil.ts";
import { filesWithMarkers, mergeInProgress, unmergedFiles } from "./merge.ts";
import { git, gitOut, revParse } from "./proc.ts";
import { ensureClone, type RepoSettings, readSettings, withRepoLock } from "./repos.ts";
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
		let metas: string[];
		try {
			metas = fs.readdirSync(taskMetaDir(env, repo)).filter((f) => f.endsWith(".json"));
		} catch {
			continue;
		}
		if (metas.length === 0) continue;
		await git(env, cloneDir(env, repo), ["fetch", "--prune", "-q", "hub"], { allowFail: true });
		const infos = await Promise.all(
			metas.map((f) => f.slice(0, -5)).filter(isSlug).map((slug) => taskInfo(env, repo, slug, settings)),
		);
		out.push(...infos.sort((a, b) => a.createdAt - b.createdAt));
	}
	return out;
}

export async function getTask(env: RompEnv, repo: string, slug: string): Promise<TaskInfo> {
	requireMeta(env, repo, slug);
	return taskInfo(env, repo, slug, readSettings(env, repo));
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
