import fs from "node:fs";
import path from "node:path";
import type { LandMode, RepoAdd, RepoInfo, RepoSettingsUpdate } from "@romp/protocol";
import {
	cloneDir,
	hubDir,
	isRepoName,
	QUEUE_STATES,
	type RompEnv,
	settingsFile,
	workRootLock,
} from "./env.ts";
import { RompError } from "./errors.ts";
import { ensureDir, makeGroupShared, SHARED_DIR_MODE, withLock, writeFileAtomic } from "./fsutil.ts";
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

export async function listRepos(env: RompEnv): Promise<RepoInfo[]> {
	return Promise.all(repoNames(env).map((name) => getRepo(env, name)));
}

function requireRoot(env: RompEnv): void {
	if (!fs.existsSync(path.join(env.root, "hub")) || !fs.existsSync(path.join(env.root, "repos")))
		throw new RompError("not_found", `romp root ${env.root} is not initialized (run \`romp init\` as root)`);
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
	writeSettings(env, name, settings);
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
const cloneRefspecs = (env: RompEnv, branch: string) => [
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
	await git(env, clone, ["fetch", "--prune", "-q", "hub"]);
	return settings;
}

/** Run `fn` holding the per-user lock for `repo` (serializes clone, worktree and checkpoint work). */
export function withRepoLock<T>(env: RompEnv, repo: string, fn: () => Promise<T>): Promise<T> {
	ensureDir(env.workRoot);
	return withLock(workRootLock(env, repo), fn);
}
