import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RompError } from "./errors.ts";

export interface RompEnv {
	/** Shared tree: hub repos, settings, queue, status. `$ROMP_ROOT` or `/srv/romp`. */
	root: string;
	/** Linux account the process acts for. */
	user: string;
	home: string;
	/** Per-user clones and task worktrees. `$ROMP_WORK` or `~/romp`. */
	workRoot: string;
}

/** The shared tree people's gateways and the merge queue use, and the checkout install.sh runs ROMP from. */
const LIVE_ROOT = "/srv/romp";
const INSTALLED_SRC = "/opt/romp";

export function rompEnv(overrides: Partial<RompEnv> = {}): RompEnv {
	const user = overrides.user ?? os.userInfo().username;
	const home = overrides.home ?? os.homedir();
	const root = overrides.root ?? (process.env.ROMP_ROOT || LIVE_ROOT);
	assertMayUseRoot(root, fs.realpathSync(import.meta.dir));
	return {
		root,
		user,
		home,
		workRoot: overrides.workRoot ?? (process.env.ROMP_WORK || path.join(home, "romp")),
	};
}

/**
 * Only the installed ROMP may touch the live root. A development copy (a task worktree, a test gateway) run with the
 * inherited `ROMP_ROOT` would otherwise act on everyone's real repos and merge queue. `ROMP_ALLOW_LIVE=1` overrides.
 */
export function assertMayUseRoot(root: string, codeDir: string): void {
	if (path.posix.resolve(root) !== LIVE_ROOT || codeDir.startsWith(`${INSTALLED_SRC}/`)) return;
	if (process.env.ROMP_ALLOW_LIVE === "1") return;
	throw new RompError(
		"forbidden",
		`this copy of ROMP runs from ${codeDir}, not ${INSTALLED_SRC}, so it may not use the live root ${LIVE_ROOT}. ` +
		"Point ROMP_ROOT and ROMP_WORK at scratch directories, or set ROMP_ALLOW_LIVE=1 to use it on purpose.",
	);
}

export type QueueState = "incoming" | "processing" | "done" | "failed";
export const QUEUE_STATES: readonly QueueState[] = ["incoming", "processing", "done", "failed"];

export const hubDir = (env: RompEnv, repo: string) => path.join(env.root, "hub", `${repo}.git`);
export const settingsFile = (env: RompEnv, repo: string) => path.join(env.root, "repos", `${repo}.toml`);
export const statusDir = (env: RompEnv, repo: string) => path.join(env.root, "status", repo);
export const statusFile = (env: RompEnv, repo: string, user: string, slug: string) =>
	path.join(env.root, "status", repo, `${user}--${slug}.json`);
export const queueDir = (env: RompEnv, state: QueueState) => path.join(env.root, "queue", state);
export const workDir = (env: RompEnv, repo: string) => path.join(env.root, "work", repo);
export const logsDir = (env: RompEnv) => path.join(env.root, "logs");
export const repoLogsDir = (env: RompEnv, repo: string) => path.join(env.root, "logs", repo);

/** Linux account that runs the merge queue; the only one allowed to move hub integration branches. */
export const queueUser = () => process.env.ROMP_QUEUE_USER || "romp";

export const cloneDir = (env: RompEnv, repo: string) => path.join(env.workRoot, `${repo}.git`);
export const worktreeDir = (env: RompEnv, repo: string, slug: string) => path.join(env.workRoot, repo, slug);
/** Per-user lock serializing work on one repo's clone and worktrees. */
export const workRootLock = (env: RompEnv, repo: string) => path.join(env.workRoot, `.${repo}.lock`);
/** Per-user `.env` uploads, copied into every new task worktree of the repo. */
export const repoEnvDir = (env: RompEnv) => path.join(env.home, ".config", "romp", "env");
export const repoEnvFile = (env: RompEnv, repo: string) => path.join(repoEnvDir(env), `${repo}.env`);
export const taskMetaDir = (env: RompEnv, repo: string) => path.join(cloneDir(env, repo), "romp");
export const taskBranch = (env: RompEnv, slug: string) => `agent/${env.user}/${slug}`;
export const landRef = (user: string, slug: string) => `refs/heads/land/${user}/${slug}`;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isRepoName(name: string): boolean {
	return NAME_RE.test(name) && !name.endsWith(".git") && !name.endsWith(".lock") && !name.includes("..");
}

export function isSlug(slug: string): boolean {
	return SLUG_RE.test(slug);
}

/** Quote for POSIX sh. */
export function shq(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
