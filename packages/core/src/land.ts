import fs from "node:fs";
import path from "node:path";
import { findOmp } from "./checkpoint.ts";
import { type RompEnv, shq } from "./env.ts";
import { headText } from "./fsutil.ts";
import { ensureMergeDriver, filesWithMarkers, unmergedFiles } from "./merge.ts";
import { childEnv, git, gitOut, identityEnv, revParse, run, runShell } from "./proc.ts";
import type { Job } from "./queue.ts";
import { effectiveCommands, parseRompToml, type RepoSettings } from "./repos.ts";

/** A landing failure with the output that explains it. */
export class LandError extends Error {
	readonly log: string | null;

	constructor(message: string, log: string | null = null) {
		super(message);
		this.name = "LandError";
		this.log = log;
	}
}

export interface Landed {
	/** The commit that landed; null when the integration branch already had the change. */
	commit: string | null;
	message: string;
	prUrl: string | null;
}

export interface LandContext {
	work: string;
	settings: RepoSettings;
	job: Job;
	/** The `land/<user>/<slug>` commit: the task's squashed change on top of the hub branch it shipped from. */
	landSha: string;
	logFile: string;
	log: (line: string) => void;
	sync: (env: RompEnv, work: string, settings: RepoSettings, log: (line: string) => void) => Promise<void>;
}

const LOG_TAIL = 16 * 1024;
const SETUP_TIMEOUT_MS = 20 * 60_000;
const TEST_TIMEOUT_MS = 30 * 60_000;
const RESOLVE_TIMEOUT_MS = 15 * 60_000;
const ATTEMPTS = 3;

const SKILL_FILE = path.join(import.meta.dir, "..", "skills", "resolve-merge", "SKILL.md");

/** Ask `omp -p` to resolve conflict markers in `files`; returns whatever markers remain. */
async function resolveConflicts(env: RompEnv, ctx: LandContext, base: string, files: string[]): Promise<string[]> {
	const omp = findOmp(env);
	if (!omp) {
		ctx.log("omp is not installed for the queue user; cannot resolve conflicts automatically");
		return files;
	}
	const parent = `${ctx.landSha}^`;
	const theirs = await gitOut(env, ctx.work, ["log", "-1", "--format=%B", ctx.landSha]);
	const ours = await gitOut(env, ctx.work, ["log", "--format=- %s", `${parent}..${base}`]);
	const prompt = [
		fs.readFileSync(SKILL_FILE, "utf8"),
		"",
		"## This merge",
		`Integration branch: ${ctx.settings.branch}. The change being landed (${ctx.job.user}/${ctx.job.slug}) is applied on top of it.`,
		"",
		"### Intent of the change being landed (incoming side, >>>>>>>)",
		headText(theirs, 4096),
		"",
		`### Intent of the ${ctx.settings.branch} changes it did not see (current side, <<<<<<<)`,
		headText(ours || "(no commit messages)", 4096),
		"",
		"### Files with conflict markers",
		...files.map((f) => `- ${f}`),
	].join("\n");
	ctx.log(`resolving ${files.length} conflicted file(s) with omp`);
	const out = await runShell(
		`${[omp, "-p", "--no-session", "--no-title", "--no-extensions", "--auto-approve", "--max-time", "900"].map(shq).join(" ")} "$ROMP_RESOLVE_PROMPT"`,
		{
			cwd: ctx.work,
			env: childEnv(env, { ROMP_RESOLVE_PROMPT: prompt }),
			timeoutMs: RESOLVE_TIMEOUT_MS,
			tailBytes: LOG_TAIL,
			logFile: ctx.logFile,
		},
	);
	if (out.code !== 0) ctx.log(`resolver exited with ${out.timedOut ? "timeout" : out.code}`);
	if ((await revParse(env, ctx.work, "HEAD")) !== base) throw new LandError("The resolver moved HEAD; refusing to land", out.output);
	return filesWithMarkers(ctx.work, files);
}

async function applyOnto(env: RompEnv, ctx: LandContext, base: string): Promise<string | null> {
	const { work } = ctx;
	await git(env, work, ["cherry-pick", "--quit"], { allowFail: true });
	await git(env, work, ["reset", "-q", "--hard"]);
	await git(env, work, ["checkout", "-q", "-f", "--detach", base]);
	await git(env, work, ["clean", "-q", "-ffd"]);
	const parent = await revParse(env, work, `${ctx.landSha}^`);
	if (parent === base) {
		await git(env, work, ["checkout", "-q", "-f", "--detach", ctx.landSha]);
		return ctx.landSha;
	}
	const pick = await git(env, work, ["cherry-pick", "--no-commit", ctx.landSha], { allowFail: true });
	ctx.log(`apply onto ${base.slice(0, 12)}: ${(pick.stdout + pick.stderr).trim() || "clean"}`);
	if (pick.code !== 0) {
		const conflicted = await unmergedFiles(env, work);
		if (conflicted.length === 0) throw new LandError("Applying the change failed", pick.stderr || pick.stdout);
		const marked = filesWithMarkers(work, conflicted);
		const remaining = marked.length > 0 ? await resolveConflicts(env, ctx, base, marked) : [];
		if (remaining.length > 0)
			throw new LandError(
				`Unresolved conflicts with ${ctx.settings.branch} in: ${remaining.join(", ")}`,
				fs.readFileSync(ctx.logFile, "utf8"),
			);
		await git(env, work, ["add", "-A"]);
	}
	const left = filesWithMarkers(work, (await gitOut(env, work, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean));
	if (left.length > 0) throw new LandError(`Conflict markers remain in: ${left.join(", ")}`);
	if ((await git(env, work, ["diff", "--cached", "--quiet"], { allowFail: true })).code === 0) {
		await git(env, work, ["cherry-pick", "--quit"], { allowFail: true });
		return null;
	}
	await git(env, work, ["commit", "-q", "--no-verify", "-C", ctx.landSha], { env: await identityEnv(env, work) });
	await git(env, work, ["cherry-pick", "--quit"], { allowFail: true });
	return gitOut(env, work, ["rev-parse", "HEAD"]);
}

async function runChecks(env: RompEnv, ctx: LandContext): Promise<void> {
	const toml = await git(env, ctx.work, ["show", "HEAD:.romp.toml"], { allowFail: true });
	const { setup, test } = effectiveCommands(ctx.settings, parseRompToml(toml.code === 0 ? toml.stdout : null));
	for (const [label, command, timeoutMs] of [
		["setup", setup, SETUP_TIMEOUT_MS],
		["test", test, TEST_TIMEOUT_MS],
	] as const) {
		if (!command) continue;
		ctx.log(`$ ${command}`);
		const out = await runShell(command, {
			cwd: ctx.work,
			env: childEnv(env, { CI: "1", ROMP_TASK: `${ctx.job.user}/${ctx.job.slug}` }),
			timeoutMs,
			tailBytes: LOG_TAIL,
			logFile: ctx.logFile,
		});
		if (out.code !== 0 || out.timedOut) {
			const why = out.timedOut ? `timed out after ${timeoutMs / 60_000} min` : `exited with ${out.code}`;
			throw new LandError(`${label === "test" ? "Tests" : "Setup"} failed: \`${command}\` ${why}`, out.output);
		}
	}
}

const REJECTED = /\[rejected\]|non-fast-forward|fetch first|stale info|\[remote rejected\]/;

export function githubRepo(url: string): string | null {
	const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
	return m ? `${m[1]}/${m[2]}` : null;
}

async function openPullRequest(env: RompEnv, ctx: LandContext, commit: string): Promise<string> {
	const { work, settings, job } = ctx;
	const repo = githubRepo(settings.remote ?? "");
	if (!repo) throw new LandError(`PR landing needs a GitHub remote (got ${settings.remote})`);
	const gh = Bun.which("gh");
	if (!gh) throw new LandError("PR landing needs the GitHub CLI (gh) on the queue user's PATH");
	const head = `romp/${job.user}/${job.slug}`;
	await git(env, work, ["push", "-q", "--force", "upstream", `${commit}:refs/heads/${head}`]);
	const subject = await gitOut(env, work, ["log", "-1", "--format=%s", commit]);
	const body = `${await gitOut(env, work, ["log", "-1", "--format=%b", commit])}\n\nLanded by romp for ${job.user} (task ${job.slug}).`;
	const ghEnv = childEnv(env, { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" });
	const created = await run([gh, "pr", "create", "--repo", repo, "--base", settings.branch, "--head", head, "--title", subject, "--body", body], {
		cwd: work,
		env: ghEnv,
		timeoutMs: 120_000,
	});
	let url = created.stdout.trim().split("\n").pop() ?? "";
	if (created.code !== 0) {
		const view = await run([gh, "pr", "view", head, "--repo", repo, "--json", "url", "--jq", ".url"], {
			cwd: work,
			env: ghEnv,
			timeoutMs: 60_000,
		});
		if (view.code !== 0) throw new LandError("gh pr create failed", created.stderr || created.stdout);
		url = view.stdout.trim();
	}
	const merge = await run([gh, "pr", "merge", url, "--repo", repo, "--auto", "--squash"], { cwd: work, env: ghEnv, timeoutMs: 120_000 });
	ctx.log(`gh pr merge --auto: ${(merge.stdout + merge.stderr).trim()}`);
	if (merge.code !== 0) throw new LandError(`Opened ${url} but enabling auto-merge failed`, merge.stderr || merge.stdout);
	return url;
}

/**
 * Integrate one land commit: sync, apply (mergiraf, then the omp resolver for leftovers),
 * run setup + tests, and publish per the repo's land mode. Retries when the branch moves under it.
 */
export async function landCommit(env: RompEnv, ctx: LandContext): Promise<Landed> {
	const { work, settings } = ctx;
	const b = settings.branch;
	await ensureMergeDriver(env, path.join(work, ".git"));
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		await ctx.sync(env, work, settings, ctx.log);
		const base = await revParse(env, work, `refs/remotes/origin/${b}`);
		if (!base) throw new LandError(`Hub has no ${b} branch`);
		const commit = await applyOnto(env, ctx, base);
		if (commit === null) return { commit: null, message: `Nothing left to land: ${b} already has these changes`, prUrl: null };
		await runChecks(env, ctx);
		if (settings.remote && settings.land === "pr") {
			const prUrl = await openPullRequest(env, ctx, commit);
			return { commit, message: `Pull request opened with auto-merge: ${prUrl}`, prUrl };
		}
		if (settings.remote) {
			const pushed = await git(env, work, ["push", "-q", "upstream", `${commit}:refs/heads/${b}`], {
				allowFail: true,
				timeoutMs: 10 * 60_000,
			});
			if (pushed.code !== 0) {
				const err = pushed.stderr || pushed.stdout;
				if (REJECTED.test(err) && attempt < ATTEMPTS) {
					ctx.log(`upstream ${b} moved; retrying`);
					continue;
				}
				throw new LandError(`Push to upstream ${b} failed`, err);
			}
		}
		const hub = await git(env, work, ["push", "-q", `--force-with-lease=refs/heads/${b}:${base}`, "origin", `${commit}:refs/heads/${b}`], {
			allowFail: true,
		});
		if (hub.code !== 0) {
			if (!settings.remote && attempt < ATTEMPTS) {
				ctx.log(`hub ${b} moved; retrying`);
				continue;
			}
			throw new LandError(`Updating hub ${b} failed`, hub.stderr || hub.stdout);
		}
		await git(env, work, ["update-ref", `refs/remotes/origin/${b}`, commit]);
		return { commit, message: `Landed on ${settings.remote ? "upstream " : "hub "}${b} as ${commit.slice(0, 12)}`, prUrl: null };
	}
	throw new LandError(`${b} kept moving; gave up after ${ATTEMPTS} attempts`);
}
