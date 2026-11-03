import type { AgentInfo, AgentUsage } from "@romp/protocol";
import { rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { HttpError } from "../http.ts";
import { errnoCode, errorMessage, isRecord, newId, writeFileAtomic } from "../util.ts";
import { Agent, type AgentRecord } from "./agent.ts";
import type { AgentNotice } from "./notices.ts";
import { currentShares, type UsageBook, UsageTracker } from "./usage.ts";

export interface AgentManagerOptions {
	omp: string;
	ompFound: boolean;
	stateDir: string;
	/**
	 * File that exists while any agent is mid-turn and holds how many are. `romp-update` waits for it to be gone
	 * before restarting the gateway. Null disables it.
	 */
	busyFile: string | null;
	/** `AgentInfo.task` for a working directory. */
	taskOf(cwd: string): AgentInfo["task"];
	/** Forwards an agent's notice to the user's devices. */
	notify(agent: AgentRecord, notice: AgentNotice): void;
}

/** Owns every agent session and persists them to `<state_dir>/agents.json` so they survive restarts. */
export class AgentManager {
	private readonly agents = new Map<string, Agent>();
	private readonly file: string;
	private saving: Promise<void> = Promise.resolve();
	private readonly usageTracker: UsageTracker;

	constructor(private readonly opts: AgentManagerOptions) {
		this.file = join(opts.stateDir, "agents.json");
		// A marker left by a gateway that crashed mid-turn: nothing runs yet.
		this.writeBusyFile(0);
		this.usageTracker = new UsageTracker(opts.omp, {
			books: () => {
				const books = new Map<string, UsageBook>();
				for (const agent of this.agents.values()) if (agent.usageBook) books.set(agent.id, agent.usageBook);
				return books;
			},
			apply: (changed) => {
				let any = false;
				for (const [id, book] of changed) {
					const agent = this.agents.get(id);
					if (!agent) continue;
					agent.setUsageBook(book);
					any = true;
				}
				if (any) this.persist();
			},
		});
	}

	/** Restores persisted sessions without spawning OMP; each respawns when first used. */
	async load(): Promise<void> {
		let text: string;
		try {
			text = await readFile(this.file, "utf8");
		} catch (err) {
			if (errnoCode(err) === "ENOENT") return;
			throw err;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			throw new Error(`${this.file}: ${errorMessage(err)}`);
		}
		for (const record of Array.isArray(parsed) ? parsed : []) {
			// Usage shares are an estimate: a malformed book is dropped rather than the agent.
			if (isRecord(record) && record.usage !== undefined && !isUsageBook(record.usage)) delete record.usage;
			if (!isAgentRecord(record)) {
				console.warn(`${this.file}: skipping malformed agent record`);
				continue;
			}
			this.agents.set(record.id, this.makeAgent(record, undefined));
		}
	}

	list(): AgentInfo[] {
		return [...this.agents.values()].map((agent) => agent.info()).sort((a, b) => a.createdAt - b.createdAt);
	}

	get(id: string): Agent | undefined {
		return this.agents.get(id);
	}

	/** `GET /api/agents/:id/usage`; null when the agent does not exist. Never spawns an agent's OMP. */
	async usage(id: string): Promise<AgentUsage | null> {
		const agent = this.agents.get(id);
		if (!agent) return null;
		const [limits, live] = await Promise.all([this.usageTracker.limits(), agent.usageState()]);
		return {
			model: live.model,
			limits: limits.providers,
			limitsError: limits.error,
			chat: { stats: live.stats, shares: limits.providers ? currentShares(agent.usageBook, limits.providers) : {} },
		};
	}

	/** `cwd` must already be a confined realpath. OMP starts right away so `prompt` runs without a client. */
	create(cwd: string, title: string | undefined, prompt: string | undefined): Agent {
		if (!this.opts.ompFound) {
			throw new HttpError(503, "omp_missing", `"${this.opts.omp}" was not found on PATH; set "omp" in the gateway config`);
		}
		const record: AgentRecord = {
			id: newId(),
			title: title?.trim() || basename(cwd) || cwd,
			cwd,
			createdAt: Date.now(),
			sessionFile: null,
		};
		const agent = this.makeAgent(record, prompt);
		this.agents.set(record.id, agent);
		this.persist();
		agent.ensureRunning().catch((err: unknown) => console.error(`agent ${record.id}: ${errorMessage(err)}`));
		return agent;
	}

	async remove(id: string): Promise<boolean> {
		const agent = this.agents.get(id);
		if (!agent) return false;
		this.agents.delete(id);
		this.persist();
		await agent.close(4410, "agent removed");
		return true;
	}

	/** Removes every agent working in the worktree of a task that was deleted. */
	async removeForTask(repo: string, slug: string): Promise<void> {
		const ids = [...this.agents.values()]
			.filter((agent) => agent.task?.repo === repo && agent.task.slug === slug)
			.map((agent) => agent.id);
		await Promise.all(ids.map((id) => this.remove(id)));
	}

	/** Removes every agent working in a task worktree of a repo that was deleted. */
	async removeForRepo(repo: string): Promise<void> {
		const ids = [...this.agents.values()].filter((agent) => agent.task?.repo === repo).map((agent) => agent.id);
		await Promise.all(ids.map((id) => this.remove(id)));
	}

	/** Retitles an agent and its OMP session; false when it no longer exists. */
	async rename(id: string, title: string): Promise<boolean> {
		const agent = this.agents.get(id);
		if (!agent) return false;
		await agent.setTitle(title);
		return true;
	}

	/** Stops every OMP process but keeps the records so the next gateway resumes them. */
	async shutdown(): Promise<void> {
		this.usageTracker.close();
		await Promise.all([...this.agents.values()].map((agent) => agent.close(1001, "gateway shutting down")));
		await this.saving;
		this.writeBusyFile(0);
	}

	private makeAgent(record: AgentRecord, prompt: string | undefined): Agent {
		const host = {
			omp: this.opts.omp,
			persist: () => this.persist(),
			busyChanged: () => this.busyChanged(),
			notify: (notice: AgentNotice) => this.opts.notify(record, notice),
			spent: (provider: string, usd: number) => this.usageTracker.spent(record.id, provider, usd),
		};
		return new Agent(record, this.opts.taskOf(record.cwd), host, prompt);
	}

	private busyChanged(): void {
		let busy = 0;
		for (const agent of this.agents.values()) if (agent.isBusy) busy++;
		this.writeBusyFile(busy);
		// Turn boundaries are where usage samples are taken for per-chat attribution.
		this.usageTracker.requestSample();
	}

	private writeBusyFile(busy: number): void {
		const file = this.opts.busyFile;
		if (file === null) return;
		try {
			if (busy > 0) writeFileSync(file, `${busy}\n`);
			else rmSync(file, { force: true });
		} catch (err) {
			console.error(`updating ${file}: ${errorMessage(err)}`);
		}
	}

	private persist(): void {
		const records = [...this.agents.values()].map((agent) => agent.toRecord());
		this.saving = this.saving
			.then(async () => {
				await mkdir(this.opts.stateDir, { recursive: true, mode: 0o700 });
				await writeFileAtomic(this.file, `${JSON.stringify(records, null, "\t")}\n`, 0o600);
			})
			.catch((err: unknown) => console.error(`saving ${this.file}: ${errorMessage(err)}`));
	}
}

function isAgentRecord(value: unknown): value is AgentRecord {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.title === "string" &&
		typeof value.cwd === "string" &&
		typeof value.createdAt === "number" &&
		(value.sessionFile === null || typeof value.sessionFile === "string")
	);
}

function isUsageBook(value: unknown): boolean {
	return (
		isRecord(value) &&
		Object.values(value).every(
			(entry) =>
				isRecord(entry) &&
				typeof entry.share === "number" &&
				(entry.resetsAt === null || typeof entry.resetsAt === "number"),
		)
	);
}
