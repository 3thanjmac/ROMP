import os from "node:os";
import path from "node:path";

export interface RompEnv {
	/** Shared tree: hub repos, settings, queue, status. `$ROMP_ROOT` or `/srv/romp`. */
	root: string;
	/** Linux account the process acts for. */
	user: string;
	home: string;
	/** Per-user clones and task worktrees. `$ROMP_WORK` or `~/romp`. */
	workRoot: string;
}

export function rompEnv(overrides: Partial<RompEnv> = {}): RompEnv {
	const user = overrides.user ?? os.userInfo().username;
	const home = overrides.home ?? os.homedir();
	return {
		root: overrides.root ?? (process.env.ROMP_ROOT || "/srv/romp"),
		user,
		home,
		workRoot: overrides.workRoot ?? (process.env.ROMP_WORK || path.join(home, "romp")),
	};
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
