import fs from "node:fs";
import path from "node:path";
import type { LandMode, RepoAdd, RepoBranches, RepoInfo, RepoSettingsUpdate } from "@romp/protocol";
import {
	cloneDir,
	hubDir,
	isRepoName,
	isSlug,
	QUEUE_STATES,
	repoEnvDir,
	repoEnvFile,
	type RompEnv,
	settingsFile,
	taskMetaDir,
	worktreeDir,
	workRootLock,
} from "./env.ts";
import { RompError } from "./errors.ts";
import { ensureDir, makeGroupShared, SHARED_DIR_MODE, tryWithLock, withLock, writeFileAtomic } from "./fsutil.ts";
import { ensureMergeDriver } from "./merge.ts";
import {
	git,
	gitOut,
	identityEnv,
	run,
	SHARED_RECEIVE_PACK,
	SHARED_REPO_CONFIG,
	SHARED_UPLOAD_PACK,
} from "./proc.ts";
import { landingsPending, queueLock } from "./status.ts";

/** Hub-side settings in `$ROMP_ROOT/repos/<name>.toml`. `setup`/`test` override `.romp.toml` when not null. */
export interface RepoSettings {
	remote: string | null;
	branch: string;
	land: LandMode;
	setup: string | null;
	test: string | null;
	createdAt: number;
}

export interface RepoCommands {
	setup: string | null;
	test: string | null;
}

const tomlString = (value: string) => JSON.stringify(value);

function settingsToToml(s: RepoSettings): string {
	const lines = ["# Managed by romp.", `branch = ${tomlString(s.branch)}`, `land = ${tomlString(s.land)}`];
	if (s.remote !== null) lines.push(`remote = ${tomlString(s.remote)}`);
	if (s.setup !== null) lines.push(`setup = ${tomlString(s.setup)}`);
	if (s.test !== null) lines.push(`test = ${tomlString(s.test)}`);
	lines.push(`createdAt = ${s.createdAt}`);
	return `${lines.join("\n")}\n`;
}

const optString = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function readSettings(env: RompEnv, name: string): RepoSettings {
	if (!isRepoName(name)) throw new RompError("bad_request", `Invalid repo name: ${name}`);
	let text: string;
	try {
		text = fs.readFileSync(settingsFile(env, name), "utf8");
	} catch {
		throw new RompError("not_found", `Unknown repo: ${name}`);
	}
	const raw = Bun.TOML.parse(text) as Record<string, unknown>;
	return {
		remote: optString(raw.remote),
		branch: optString(raw.branch) ?? "main",
		land: raw.land === "pr" ? "pr" : "push",
		setup: optString(raw.setup),
		test: optString(raw.test),
		createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
	};
}

function writeSettings(env: RompEnv, name: string, settings: RepoSettings): void {
	writeFileAtomic(settingsFile(env, name), settingsToToml(settings));
}

/** Parse a repository's `.romp.toml` (`setup`, `test`). Invalid files count as empty. */
export function parseRompToml(text: string | null): RepoCommands {
	if (!text) return { setup: null, test: null };
	try {
		const raw = Bun.TOML.parse(text) as Record<string, unknown>;
		return { setup: optString(raw.setup), test: optString(raw.test) };
	} catch {
		return { setup: null, test: null };
	}
}

/** Hub settings win over the repository's `.romp.toml`; an empty string disables the command. */
export function effectiveCommands(settings: RepoSettings, fromRepo: RepoCommands): RepoCommands {
	const pick = (override: string | null, fallback: string | null) => {
		const value = override ?? fallback;
		return value?.trim() ? value : null;
	};
	return { setup: pick(settings.setup, fromRepo.setup), test: pick(settings.test, fromRepo.test) };
}

/** git against a hub repository, which may belong to another member of the romp group. */
export function hubGit(env: RompEnv, repo: string, args: string[], allowFail = false) {
	return git(env, hubDir(env, repo), [...SHARED_REPO_CONFIG, ...args], { allowFail });
}

export async function getRepo(env: RompEnv, name: string): Promise<RepoInfo> {
	const settings = readSettings(env, name);
	const toml = await hubGit(env, name, ["show", `refs/heads/${settings.branch}:.romp.toml`], true);
	const commands = effectiveCommands(settings, parseRompToml(toml.code === 0 ? toml.stdout : null));
	return {
		name,
		remote: settings.remote,
		branch: settings.branch,
		land: settings.land,
		setup: commands.setup,
		test: commands.test,
		cloned: fs.existsSync(cloneDir(env, name)),
		env: fs.existsSync(repoEnvFile(env, name)),
	};
}

export function repoNames(env: RompEnv): string[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(path.join(env.root, "repos"));
	} catch {
		return [];
	}
	return entries
		.filter((f) => f.endsWith(".toml"))
		.map((f) => f.slice(0, -5))
		.filter(isRepoName)
		.sort();
}

/** Every repo, skipping ones removed while listing. */
export async function listRepos(env: RompEnv): Promise<RepoInfo[]> {
	const repos = await Promise.all(
		repoNames(env).map((name) =>
			getRepo(env, name).catch((err: unknown) => {
				if (err instanceof RompError && err.code === "not_found") return null;
				throw err;
			}),
		),
	);
	return repos.filter((r) => r !== null);
}

function requireRoot(env: RompEnv): void {
	if (!fs.existsSync(path.join(env.root, "hub")) || !fs.existsSync(path.join(env.root, "repos")))
		throw new RompError("not_found", `romp root ${env.root} is not initialized (run \`romp init\` as root)`);
}

/** Adding a repo writes into the shared hub as this user, so the running process needs the romp group. */
export function requireHubWritable(env: RompEnv): void {
	const hub = path.join(env.root, "hub");
	try {
		fs.accessSync(hub, fs.constants.W_OK);
	} catch {
		throw new RompError(
			"forbidden",
			`${env.user} cannot write to ${hub}. The account must be in the romp group, and the process adding the repo ` +
				`must have started after it joined: run \`sudo usermod -aG romp ${env.user}\`, then ` +
				`\`sudo systemctl restart user@${process.getuid?.() ?? "<uid>"}.service\` so the gateway restarts with the ` +
				`group (for the romp command, sign out and back in).`,
		);
	}
}

function nameFromUrl(url: string): string {
	const base = url.replace(/[/\\]+$/, "").split(/[/\\:]/).pop() ?? "";
	return base.replace(/\.git$/, "");
}

const HOOK = (kind: string) => `#!/bin/sh\n# Managed by romp.\nexec romp hook ${kind}\n`;

function installHooks(gitDir: string): void {
	for (const kind of ["pre-receive", "post-receive"]) {
		const file = path.join(gitDir, "hooks", kind);
		fs.writeFileSync(file, HOOK(kind), { mode: 0o775 });
		fs.chmodSync(file, 0o775);
	}
}

/** Paths and file:// URLs: the far side is a repository on this machine, possibly owned by another user. */
export const isLocalUrl = (url: string) => url.startsWith("/") || url.startsWith("file://");

/** Create the hub repository (bare, group-shared) from an upstream URL, or empty when `url` is "". */
export async function addRepo(env: RompEnv, add: RepoAdd): Promise<RepoInfo> {
	requireRoot(env);
	requireHubWritable(env);
	const url = add.url.trim();
	const name = add.name?.trim() || nameFromUrl(url);
	if (!name) throw new RompError("bad_request", "A hub-only repo needs a name");
	if (!isRepoName(name)) throw new RompError("bad_request", `Invalid repo name: ${name}`);
	const branchArg = add.branch?.trim();
	if (branchArg !== undefined && branchArg !== "") {
		const ok = await run(["git", "check-ref-format", "--branch", branchArg], { cwd: env.root });
		if (ok.code !== 0) throw new RompError("bad_request", `Invalid branch: ${branchArg}`);
	}
	const hub = hubDir(env, name);
	if (fs.existsSync(hub) || fs.existsSync(settingsFile(env, name)))
		throw new RompError("conflict", `Repo ${name} already exists`);
	const tmp = path.join(env.root, "hub", `.tmp-${name}-${process.pid}-${Date.now()}`);
	let branch: string;
	try {
		if (url) {
			const args = ["clone", "--bare", "--no-local", "--single-branch"];
			if (isLocalUrl(url)) args.push("--upload-pack", SHARED_UPLOAD_PACK);
			if (branchArg) args.push("--branch", branchArg);
			await git(env, env.root, [...args, "--", url, tmp], { timeoutMs: 30 * 60_000 });
			branch = branchArg || (await gitOut(env, tmp, ["symbolic-ref", "--short", "HEAD"]));
			await git(env, tmp, ["remote", "remove", "origin"], { allowFail: true });
			if (!(await git(env, tmp, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`], { allowFail: true })).stdout)
				throw new RompError("bad_request", `Upstream has no branch ${branch}`);
		} else {
			branch = branchArg || "main";
			await git(env, env.root, ["init", "--bare", "-q", `--initial-branch=${branch}`, tmp]);
			const tree = await gitOut(env, tmp, ["mktree"], { input: "" });
			const commit = await gitOut(env, tmp, ["commit-tree", tree, "-m", "romp: initial commit"], {
				env: await identityEnv(env, tmp),
			});
			await git(env, tmp, ["update-ref", `refs/heads/${branch}`, commit]);
		}
		await git(env, tmp, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
		for (const [key, value] of [
			["core.sharedRepository", "group"],
			["receive.denyNonFastForwards", "false"],
			["receive.denyDeletes", "false"],
			["receive.denyDeleteCurrent", "refuse"],
		] as const)
			await git(env, tmp, ["config", "--local", key, value]);
		installHooks(tmp);
		makeGroupShared(tmp);
		fs.renameSync(tmp, hub);
	} catch (err) {
		fs.rmSync(tmp, { recursive: true, force: true });
		throw err;
	}
	writeSettings(env, name, {
		remote: url || null,
		branch,
		land: "push",
		setup: null,
		test: null,
		createdAt: Date.now(),
	});
	return getRepo(env, name);
}

/** `git check-ref-format --branch`, plus romp's own namespaces, which are never integration branches. */
async function requireBranchName(env: RompEnv, branch: string): Promise<void> {
	const ok = await run(["git", "check-ref-format", "--branch", branch], { cwd: env.root });
	if (ok.code !== 0 || branch.startsWith("-") || isRompBranch(branch))
		throw new RompError("bad_request", `Invalid branch: ${branch}`);
}

const isRompBranch = (branch: string) => branch.startsWith("agent/") || branch.startsWith("land/");

export async function updateRepoSettings(env: RompEnv, name: string, update: RepoSettingsUpdate): Promise<RepoInfo> {
	const settings = readSettings(env, name);
	if (update.land !== undefined) {
		if (update.land !== "push" && update.land !== "pr") throw new RompError("bad_request", "land must be push or pr");
		if (update.land === "pr" && settings.remote === null)
			throw new RompError("bad_request", "A hub-only repo cannot land through pull requests");
		settings.land = update.land;
	}
	if (update.setup !== undefined) settings.setup = update.setup;
	if (update.test !== undefined) settings.test = update.test;
	const branch = update.branch?.trim();
	if (branch === undefined || branch === settings.branch) {
		writeSettings(env, name, settings);
		return getRepo(env, name);
	}
	await requireBranchName(env, branch);
	requireHubWritable(env);
	await withQueueIdle(env, name, "switching its branch", async () => {
		const fresh = { ...readSettings(env, name), land: settings.land, setup: settings.setup, test: settings.test };
		const ref = `refs/heads/${branch}`;
		if (!(await hubGit(env, name, ["rev-parse", "-q", "--verify", ref], true)).stdout.trim()) {
			if (fresh.remote === null) throw new RompError("bad_request", `The hub has no branch ${branch}`);
			const args = ["fetch", "-q", "--no-tags"];
			if (isLocalUrl(fresh.remote)) args.push("--upload-pack", SHARED_UPLOAD_PACK);
			const fetched = await git(env, hubDir(env, name), [...SHARED_REPO_CONFIG, ...args, "--", fresh.remote, `+${ref}:${ref}`], {
				allowFail: true,
				timeoutMs: 30 * 60_000,
			});
			if (fetched.code !== 0) {
				const detail = (fetched.stderr.trim() || fetched.stdout.trim()).split("\n").slice(-3).join("\n");
				throw new RompError("bad_request", `Could not fetch ${branch} from ${fresh.remote}: ${detail}`);
			}
		}
		await hubGit(env, name, ["symbolic-ref", "HEAD", ref]);
		fresh.branch = branch;
		writeSettings(env, name, fresh);
	});
	return getRepo(env, name);
}

/**
 * Run `fn` holding the merge queue's lock for `repo`, refusing (409) while a landing for it is queued or running.
 * The queue skips a repo whose lock is held, so nothing lands while `fn` runs.
 */
export async function withQueueIdle(env: RompEnv, repo: string, doing: string, fn: () => Promise<void>): Promise<void> {
	const busy = () => new RompError("conflict", `A landing for ${repo} is queued or running; try ${doing} when it finishes`);
	ensureDir(path.join(env.root, "work"), SHARED_DIR_MODE);
	const done = await tryWithLock(queueLock(env, repo), async () => {
		if (landingsPending(env, repo)) throw busy();
		await fn();
		return true;
	});
	if (done === null) throw busy();
}

/** Heads to offer as the integration branch: upstream's when the repo has one, else the hub's. */
export async function repoBranches(env: RompEnv, name: string): Promise<RepoBranches> {
	const settings = readSettings(env, name);
	let refs: string[];
	if (settings.remote) {
		const args = ["ls-remote", "--heads"];
		if (isLocalUrl(settings.remote)) args.push("--upload-pack", SHARED_UPLOAD_PACK);
		const out = await gitOut(env, env.root, [...SHARED_REPO_CONFIG, ...args, "--", settings.remote], { timeoutMs: 60_000 });
		refs = out.split("\n").map((line) => line.split("\t")[1] ?? "");
	} else {
		refs = (await hubGit(env, name, ["for-each-ref", "--format=%(refname)", "refs/heads/"])).stdout.split("\n");
	}
	const others = refs
		.filter((ref) => ref.startsWith("refs/heads/"))
		.map((ref) => ref.slice("refs/heads/".length))
		.filter((b) => b !== settings.branch && !isRompBranch(b))
		.sort();
	return { current: settings.branch, branches: [settings.branch, ...others] };
}

/** Lines romp keeps in every user clone's `info/exclude` (shared by all its worktrees). */
const CLONE_EXCLUDES = ["/.env"];

function ensureCloneExcludes(clone: string): void {
	const file = path.join(clone, "info", "exclude");
	let text = "";
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		ensureDir(path.dirname(file));
	}
	const have = new Set(text.split("\n").map((l) => l.trim()));
	const missing = CLONE_EXCLUDES.filter((line) => !have.has(line));
	if (missing.length === 0) return;
	const sep = text && !text.endsWith("\n") ? "\n" : "";
	fs.appendFileSync(file, `${sep}# romp: never commit the uploaded .env\n${missing.join("\n")}\n`);
}

/** This user's task slugs for `repo` (from the clone's task metadata). */
export function taskSlugs(env: RompEnv, repo: string): string[] {
	try {
		return fs
			.readdirSync(taskMetaDir(env, repo))
			.filter((f) => f.endsWith(".json"))
			.map((f) => f.slice(0, -5))
			.filter(isSlug);
	} catch {
		return [];
	}
}

/** Copy the user's uploaded `.env` for `repo` into a worktree (mode 0600). No-op without an upload. */
export function copyRepoEnv(env: RompEnv, repo: string, worktree: string): void {
	let data: Buffer;
	try {
		data = fs.readFileSync(repoEnvFile(env, repo));
	} catch {
		return;
	}
	writeFileAtomic(path.join(worktree, ".env"), data, 0o600);
}

/** Store this user's `.env` for `repo` and refresh it in their existing task worktrees. */
export async function setRepoEnv(env: RompEnv, name: string, data: Uint8Array): Promise<RepoInfo> {
	readSettings(env, name);
	const dir = repoEnvDir(env);
	ensureDir(dir, 0o700);
	fs.chmodSync(dir, 0o700);
	writeFileAtomic(repoEnvFile(env, name), data, 0o600);
	if (fs.existsSync(cloneDir(env, name))) {
		await withRepoLock(env, name, async () => {
			ensureCloneExcludes(cloneDir(env, name));
			for (const slug of taskSlugs(env, name)) {
				const wt = worktreeDir(env, name, slug);
				if (fs.existsSync(wt)) copyRepoEnv(env, name, wt);
			}
		});
	}
	return getRepo(env, name);
}

/** Forget this user's `.env` for `repo`. Copies already in worktrees stay. */
export async function clearRepoEnv(env: RompEnv, name: string): Promise<RepoInfo> {
	readSettings(env, name);
	fs.rmSync(repoEnvFile(env, name), { force: true });
	return getRepo(env, name);
}

/** Parse /etc/group for a group id. */
function groupId(group: string): number | null {
	for (const line of fs.readFileSync("/etc/group", "utf8").split("\n")) {
		const [gname, , gid] = line.split(":");
		if (gname === group && gid !== undefined) return Number(gid);
	}
	return null;
}

/**
 * Create the shared tree. As root it creates the group when missing and hands every
 * directory to root:<group> with mode 2775; otherwise it only creates and chmods.
 */
export async function initRoot(env: RompEnv, group = "romp"): Promise<string[]> {
	const isRoot = process.getuid?.() === 0;
	let gid = groupId(group);
	if (gid === null && isRoot) {
		const made = await run(["groupadd", "--system", group], { cwd: "/" });
		if (made.code !== 0) throw new RompError("git_failed", `groupadd ${group} failed: ${made.stderr.trim()}`);
		gid = groupId(group);
	}
	if (gid === null && isRoot) throw new RompError("not_found", `Group ${group} does not exist`);
	const dirs = [
		env.root,
		...["hub", "repos", "queue", "status", "work", "logs"].map((d) => path.join(env.root, d)),
		...QUEUE_STATES.map((s) => path.join(env.root, "queue", s)),
	];
	for (const dir of dirs) {
		ensureDir(dir, SHARED_DIR_MODE);
		if (isRoot && gid !== null) fs.chownSync(dir, 0, gid);
		fs.chmodSync(dir, SHARED_DIR_MODE);
	}
	return dirs;
}

/** Fetch refspecs for a user clone: the integration branch and the user's own task branches. */
export const cloneRefspecs = (env: RompEnv, branch: string) => [
	`+refs/heads/${branch}:refs/remotes/hub/${branch}`,
	`+refs/heads/agent/${env.user}/*:refs/remotes/hub/agent/${env.user}/*`,
];

export async function configureHubRemote(env: RompEnv, gitDir: string, remote: string, url: string): Promise<void> {
	await git(env, gitDir, ["config", "--local", `remote.${remote}.url`, url]);
	await git(env, gitDir, ["config", "--local", `remote.${remote}.uploadpack`, SHARED_UPLOAD_PACK]);
	await git(env, gitDir, ["config", "--local", `remote.${remote}.receivepack`, SHARED_RECEIVE_PACK]);
}

/**
 * Make sure the user's bare clone `~/romp/<repo>.git` exists and is configured, then fetch.
 * Callers hold the repo's work-root lock.
 */
export async function ensureClone(env: RompEnv, repo: string): Promise<RepoSettings> {
	const settings = readSettings(env, repo);
	const clone = cloneDir(env, repo);
	if (!fs.existsSync(clone)) {
		ensureDir(env.workRoot);
		const tmp = `${clone}.tmp-${process.pid}`;
		fs.rmSync(tmp, { recursive: true, force: true });
		try {
			await git(env, env.workRoot, ["init", "--bare", "-q", tmp]);
			await configureHubRemote(env, tmp, "hub", hubDir(env, repo));
			fs.renameSync(tmp, clone);
		} catch (err) {
			fs.rmSync(tmp, { recursive: true, force: true });
			throw err;
		}
	}
	await git(env, clone, ["config", "--local", "--unset-all", "remote.hub.fetch"], { allowFail: true });
	for (const spec of cloneRefspecs(env, settings.branch))
		await git(env, clone, ["config", "--local", "--add", "remote.hub.fetch", spec]);
	await ensureMergeDriver(env, clone);
	ensureCloneExcludes(clone);
	await git(env, clone, ["fetch", "--prune", "-q", "hub"]);
	return settings;
}

/** Run `fn` holding the per-user lock for `repo` (serializes clone, worktree and checkpoint work). */
export function withRepoLock<T>(env: RompEnv, repo: string, fn: () => Promise<T>): Promise<T> {
	ensureDir(env.workRoot);
	return withLock(workRootLock(env, repo), fn);
}
