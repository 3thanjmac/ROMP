import { type RompEnv, readTaskSetup, taskSetupCommand, writeTaskSetup } from "@romp/core";
import type { TaskInfo, TaskSetup } from "@romp/protocol";
import { conflict, HttpError } from "./http.ts";
import type { TerminalManager, TerminalSession } from "./terminals.ts";
import { errorMessage } from "./util.ts";

/**
 * Runs each new task's setup command in a ROMP terminal (so its log can be attached to) and records the outcome
 * next to the task's metadata. A successful run's terminal is closed unless someone is watching it.
 */
export class TaskSetups {
	/** `repo/slug` → the terminal of its latest setup run, while this gateway has it. */
	private readonly termIds = new Map<string, string>();

	constructor(
		private readonly terms: TerminalManager,
		private readonly romp: RompEnv,
		private readonly shell: string,
	) {}

	/** Starts the task's setup in `cwd` (the worktree's confined realpath). Null when the repo has no setup command. */
	start(task: Pick<TaskInfo, "repo" | "slug">, cwd: string): TaskSetup | null {
		const { repo, slug } = task;
		const key = `${repo}/${slug}`;
		if (readTaskSetup(this.romp, repo, slug)?.state === "running") throw conflict("Setup is already running for this task");
		const command = taskSetupCommand(this.romp, repo, slug);
		if (!command) return null;
		this.discard(repo, slug);
		let term: TerminalSession;
		try {
			term = this.terms.create({ argv: [this.shell, "-lc", command], cwd, cols: 100, rows: 30, title: `setup · ${slug}` });
		} catch (err) {
			console.warn(`setup ${key}: ${errorMessage(err)}`);
			const failed: TaskSetup = { state: "failed", termId: null, exitCode: null };
			writeTaskSetup(this.romp, repo, slug, failed);
			return failed;
		}
		this.termIds.set(key, term.id);
		const running: TaskSetup = { state: "running", termId: term.id, exitCode: null };
		writeTaskSetup(this.romp, repo, slug, running);
		void term.done.then((code) => {
			// Retried, or the task was deleted, while this run was going.
			if (this.termIds.get(key) !== term.id) return;
			const ok = code === 0;
			if (ok && term.info().clients === 0) this.terms.remove(term.id);
			const kept = this.terms.get(term.id) !== undefined;
			if (!kept) this.termIds.delete(key);
			writeTaskSetup(this.romp, repo, slug, { state: ok ? "done" : "failed", termId: kept ? term.id : null, exitCode: code });
		});
		return running;
	}

	/** Like `start`, for the retry route: 422 when the repo has no setup command. */
	retry(task: Pick<TaskInfo, "repo" | "slug">, cwd: string): TaskSetup {
		const setup = this.start(task, cwd);
		if (!setup) throw new HttpError(422, "no_setup_command", "This repo has no setup command");
		return setup;
	}

	/** Drops a `termId` whose terminal is gone (closed by the user), so the client never attaches to nothing. */
	view<T extends Pick<TaskInfo, "setup">>(task: T): T {
		const termId = task.setup?.termId;
		if (!task.setup || !termId || this.terms.get(termId)) return task;
		return { ...task, setup: { ...task.setup, termId: null } };
	}

	/** Closes the task's setup terminal (task deleted, or about to run again); a run it cuts short counts as failed. */
	discard(repo: string, slug: string): void {
		const key = `${repo}/${slug}`;
		const termId = this.termIds.get(key);
		if (termId === undefined) return;
		this.termIds.delete(key);
		this.terms.remove(termId);
		if (readTaskSetup(this.romp, repo, slug)?.state === "running")
			writeTaskSetup(this.romp, repo, slug, { state: "failed", termId: null, exitCode: null });
	}

	/** Closes the setup terminals of every task in a deleted repo. */
	discardRepo(repo: string): void {
		for (const key of [...this.termIds.keys()]) {
			if (key.startsWith(`${repo}/`)) this.discard(repo, key.slice(repo.length + 1));
		}
	}
}
