#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import type { LandMode, RepoSettingsUpdate } from "@romp/protocol";
import { checkpoint, shipTask } from "./checkpoint.ts";
import { QUEUE_STATES, queueDir, type RompEnv, rompEnv } from "./env.ts";
import { RompError } from "./errors.ts";
import { killLiveGroups } from "./proc.ts";
import { type OmpDefaultsResult, ompDefaultsPaths, setOmpDefaultsOptOut, syncOmpDefaults } from "./ompdefaults.ts";
import { postReceive, preReceive, runOnce, serve } from "./queue.ts";
import { addRepo, initRoot, listRepos, updateRepoSettings } from "./repos.ts";
import { createTask, listTasks, removeTask, taskForPath } from "./tasks.ts";

const USAGE = `usage: romp <command>

  init [--group romp]                          create $ROMP_ROOT (run as root once)
  repo add <url> [--name n] [--branch b]       add a repo from an upstream URL
  repo add --name n [--branch b]               add a hub-only repo (no upstream)
  repo list [--json]
  repo set <name> land=push|pr test=<cmd> setup=<cmd>   (empty value: none; "-": use .romp.toml)
  task new <repo> <title...> [--slug s] [--json]
  task list [--json]
  task rm <repo> <slug>
  checkpoint [path] [--json]                   commit, back up and sync the task (exit 3 on conflict)
  ship [path] [--message m] [--json]           queue the task for landing
  status [--json]                              this user's tasks and the queue depth
  queue serve                                  merge queue service (run as the romp user)
  queue run-once                               process everything queued, then exit
  hook pre-receive | post-receive              hub git hooks
  omp-defaults [status|sync|on|off]            shared OMP settings from deploy/omp-defaults (models stay yours)

env: ROMP_ROOT (default /srv/romp), ROMP_WORK (default ~/romp), ROMP_QUEUE_USER (default romp)`;

class UsageError extends Error {}

interface Args {
	positional: string[];
	flags: Map<string, string | true>;
}

const BOOLEAN_FLAGS: Record<string, true> = { json: true, help: true };

function parseArgs(argv: string[]): Args {
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") {
			positional.push(...argv.slice(i + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
			if (eq !== -1) flags.set(name, arg.slice(eq + 1));
			else if (BOOLEAN_FLAGS[name]) flags.set(name, true);
			else {
				const value = argv[++i];
				if (value === undefined) throw new UsageError(`--${name} needs a value`);
				flags.set(name, value);
			}
		} else if (arg === "-h") flags.set("help", true);
		else positional.push(arg);
	}
	return { positional, flags };
}

function flag(args: Args, name: string): string | undefined {
	const value = args.flags.get(name);
	return typeof value === "string" ? value : undefined;
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

function taskAt(env: RompEnv, target: string | undefined): { repo: string; slug: string } {
	const dir = path.resolve(target ?? process.cwd());
	const task = taskForPath(env, dir);
	if (!task) throw new RompError("not_found", `${dir} is not inside a romp task worktree (${env.workRoot}/<repo>/<slug>)`);
	return task;
}

function parseSetting(update: RepoSettingsUpdate, pair: string): void {
	const eq = pair.indexOf("=");
	if (eq === -1) throw new UsageError(`expected key=value, got ${pair}`);
	const key = pair.slice(0, eq);
	const value = pair.slice(eq + 1);
	if (key === "land") {
		if (value !== "push" && value !== "pr") throw new UsageError("land must be push or pr");
		update.land = value as LandMode;
	} else if (key === "test" || key === "setup") update[key] = value === "-" ? null : value;
	else throw new UsageError(`unknown setting ${key} (land, test, setup)`);
}

function queueDepth(env: RompEnv): Record<string, number> {
	const out: Record<string, number> = {};
	for (const state of QUEUE_STATES) {
		try {
			out[state] = fs.readdirSync(queueDir(env, state)).filter((n) => n.endsWith(".json") && !n.startsWith(".")).length;
		} catch {
			out[state] = 0;
		}
	}
	return out;
}

const PENDING_VERB: Record<string, string> = { created: "would create", updated: "would update", removed: "would remove", kept: "keeps" };

function printOmpDefaults(result: OmpDefaultsResult, dryRun: boolean): void {
	if (result.optedOut) {
		console.log("shared OMP settings are off for you (romp omp-defaults on to resume)");
		return;
	}
	if (result.actions.length === 0) console.log(dryRun ? "OMP settings are up to date" : "OMP settings already up to date");
	for (const a of result.actions)
		console.log(`${dryRun ? PENDING_VERB[a.change] : a.change} ${a.file}${a.detail ? ` (${a.detail})` : ""}`);
}

async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	const [cmd, sub, ...rest] = args.positional;
	const json = args.flags.has("json");
	if (!cmd || args.flags.has("help")) {
		console.log(USAGE);
		return cmd ? 0 : 2;
	}
	const env = rompEnv();
	switch (cmd) {
		case "init": {
			const dirs = await initRoot(env, flag(args, "group") ?? "romp");
			console.log(`romp root ready at ${env.root} (${dirs.length} directories)`);
			return 0;
		}
		case "repo": {
			if (sub === "add") {
				const url = rest[0] ?? "";
				const name = flag(args, "name");
				if (!url && !name) throw new UsageError("repo add needs a URL or --name for a hub-only repo");
				const repo = await addRepo(env, { url, name, branch: flag(args, "branch") });
				if (json) print(repo);
				else console.log(`added ${repo.name} (${repo.remote ?? "hub-only"}, branch ${repo.branch})`);
				return 0;
			}
			if (sub === "list") {
				const repos = await listRepos(env);
				if (json) print(repos);
				else
					for (const r of repos)
						console.log(`${r.name}\t${r.branch}\t${r.land}\t${r.remote ?? "(hub-only)"}${r.test ? `\ttest: ${r.test}` : ""}`);
				return 0;
			}
			if (sub === "set") {
				const [name, ...pairs] = rest;
				if (!name || pairs.length === 0) throw new UsageError("repo set <name> key=value...");
				const update: RepoSettingsUpdate = {};
				for (const pair of pairs) parseSetting(update, pair);
				const repo = await updateRepoSettings(env, name, update);
				if (json) print(repo);
				else console.log(`${repo.name}: land=${repo.land} setup=${repo.setup ?? "-"} test=${repo.test ?? "-"}`);
				return 0;
			}
			break;
		}
		case "task": {
			if (sub === "new") {
				const [repo, ...words] = rest;
				if (!repo || words.length === 0) throw new UsageError("task new <repo> <title...>");
				const task = await createTask(env, { repo, title: words.join(" "), slug: flag(args, "slug") });
				if (json) print(task);
				else console.log(task.path);
				return 0;
			}
			if (sub === "list") {
				const tasks = await listTasks(env);
				if (json) print(tasks);
				else
					for (const t of tasks)
						console.log(`${t.repo}/${t.slug}\t${t.status}${t.dirty ? "*" : ""}\t+${t.ahead} -${t.behind}\t${t.title}`);
				return 0;
			}
			if (sub === "rm") {
				const [repo, slug] = rest;
				if (!repo || !slug) throw new UsageError("task rm <repo> <slug>");
				await removeTask(env, repo, slug);
				if (!json) console.log(`removed ${repo}/${slug}`);
				else print({ removed: `${repo}/${slug}` });
				return 0;
			}
			break;
		}
		case "checkpoint": {
			const { repo, slug } = taskAt(env, sub);
			const result = await checkpoint(env, repo, slug);
			if (json) print(result);
			else {
				console.log(result.message);
				for (const f of result.conflictFiles) console.log(`  ${f}`);
			}
			return result.status === "conflict" ? 3 : 0;
		}
		case "ship": {
			const { repo, slug } = taskAt(env, sub);
			const task = await shipTask(env, repo, slug, { message: flag(args, "message") });
			if (json) print(task);
			else console.log(`${repo}/${slug}: ${task.landing?.message ?? task.status}`);
			return 0;
		}
		case "status": {
			const tasks = await listTasks(env);
			const queue = queueDepth(env);
			if (json) print({ tasks, queue });
			else {
				for (const t of tasks)
					console.log(
						`${t.repo}/${t.slug}\t${t.status}${t.dirty ? " (unsaved)" : ""}\t${t.landing ? t.landing.message : ""}`,
					);
				console.log(`queue: ${queue.incoming} incoming, ${queue.processing} processing`);
			}
			return 0;
		}
		case "queue": {
			if (sub === "run-once") {
				const handled = await runOnce(env);
				console.log(`processed ${handled} job(s)`);
				return 0;
			}
			if (sub === "serve") {
				const controller = new AbortController();
				const stop = () => {
					controller.abort();
					killLiveGroups();
				};
				process.on("SIGTERM", stop);
				process.on("SIGINT", stop);
				const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
				log(`romp queue serving ${env.root} as ${env.user}`);
				await serve(env, log, controller.signal);
				return 0;
			}
			break;
		}
		case "hook": {
			const input = await Bun.stdin.text();
			if (sub === "pre-receive") {
				const errors = preReceive(input);
				for (const e of errors) console.error(e);
				return errors.length > 0 ? 1 : 0;
			}
			if (sub === "post-receive") {
				const gitDir = path.resolve(process.env.GIT_DIR ?? ".");
				for (const job of postReceive(gitDir, input))
					console.error(`romp: queued ${job.user}/${job.slug} (${job.commit.slice(0, 12)}) for landing`);
				return 0;
			}
			break;
		}
		case "omp-defaults": {
			const paths = ompDefaultsPaths(env);
			const action = sub ?? "status";
			if (action === "off") setOmpDefaultsOptOut(paths, true);
			else if (action === "on") setOmpDefaultsOptOut(paths, false);
			else if (action !== "status" && action !== "sync") break;
			const dryRun = action === "status";
			const result = action === "off" ? { optedOut: true, actions: [] } : syncOmpDefaults(paths, { dryRun });
			if (json) print(result);
			else printOmpDefaults(result, dryRun);
			return 0;
		}
	}
	throw new UsageError(`unknown command: ${args.positional.join(" ")}`);
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (err) {
	const json = process.argv.includes("--json");
	if (err instanceof UsageError) {
		console.error(`romp: ${err.message}\n\n${USAGE}`);
		process.exitCode = 2;
	} else {
		const code = err instanceof RompError ? err.code : "error";
		const message = err instanceof Error ? err.message : String(err);
		if (json) print({ error: { code, message } });
		else console.error(`romp: ${message}`);
		process.exitCode = err instanceof RompError && err.code === "conflict" ? 3 : 1;
	}
}
