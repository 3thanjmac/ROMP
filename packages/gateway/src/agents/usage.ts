import type { AgentUsage, UsageLimit, UsageProvider } from "@romp/protocol";
import type { Subprocess } from "bun";
import { errorMessage, isRecord } from "../util.ts";

export type ChatStats = NonNullable<AgentUsage["chat"]["stats"]>;
export type ChatModel = NonNullable<AgentUsage["model"]>;

/** An agent's estimated share of each limit, keyed by `UsageLimit.id`, tied to the window (`resetsAt`) it was measured in. */
export type UsageBook = Record<string, { share: number; resetsAt: number | null }>;
/** USD spent during one sample interval: agent id → provider → USD. */
export type Spend = Map<string, Map<string, number>>;

export interface UsageTrackerHost {
	/** The current book of every agent that has one. */
	books(): Map<string, UsageBook>;
	/** Stores the books a sample changed; ids of removed agents may appear and are ignored. */
	apply(changed: Map<string, UsageBook>): void;
}

const RUN_TIMEOUT_MS = 20_000;
/** How long a fetched report answers `limits()` without running OMP again. */
const MEMO_MS = 15_000;
/** Minimum spacing of attribution samples. */
const SAMPLE_INTERVAL_MS = 15_000;
/** Turn boundaries within this delay share one sample. */
const SAMPLE_DEBOUNCE_MS = 2_000;
/** Providers may move `resetsAt` a little between reports of the same window. */
const RESET_TOLERANCE_MS = 5 * 60_000;
const STDERR_CHARS = 300;

/**
 * Account limits from `omp usage --json` plus a per-agent estimate of how much of each limit an agent consumed.
 *
 * Limits are account-wide, so attribution is estimated: the tracker samples them at turn boundaries and splits each
 * limit's increase between two samples across agents in proportion to the USD they spent on that provider in between.
 * Increases without ROMP spend are external usage and go to nobody. Samples only follow turn boundaries, so nothing
 * runs while every agent is idle.
 */
export class UsageTracker {
	private memo: { providers: UsageProvider[]; at: number } | null = null;
	private inflight: Promise<UsageProvider[]> | null = null;
	/** The last sample; attribution compares the next one against it. */
	private baseline: UsageProvider[] | null = null;
	private spend: Spend = new Map();
	private timer: Timer | null = null;
	private sampling = false;
	private sampleAgain = false;
	private lastSampleAt = 0;
	private closed = false;

	constructor(
		private readonly omp: string,
		private readonly host: UsageTrackerHost,
	) {}

	/** The account limits, from a report at most `MEMO_MS` old. Never throws. */
	async limits(): Promise<{ providers: UsageProvider[] | null; error: string | null }> {
		if (this.memo && Date.now() - this.memo.at < MEMO_MS) return { providers: this.memo.providers, error: null };
		try {
			return { providers: await (this.inflight ?? this.fetch()), error: null };
		} catch (err) {
			return { providers: null, error: errorMessage(err) };
		}
	}

	/** Records USD an agent's assistant message cost on `provider`. */
	spent(agentId: string, provider: string, usd: number): void {
		if (!(usd > 0)) return;
		let perAgent = this.spend.get(agentId);
		if (!perAgent) this.spend.set(agentId, (perAgent = new Map()));
		perAgent.set(provider, (perAgent.get(provider) ?? 0) + usd);
	}

	/** Asks for a sample at a turn boundary. Requests coalesce, and samples are at least `SAMPLE_INTERVAL_MS` apart. */
	requestSample(): void {
		if (this.closed || this.timer) return;
		if (this.sampling) {
			this.sampleAgain = true;
			return;
		}
		const wait = Math.max(SAMPLE_DEBOUNCE_MS, this.lastSampleAt + SAMPLE_INTERVAL_MS - Date.now());
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.sample();
		}, wait);
	}

	close(): void {
		this.closed = true;
		clearTimeout(this.timer ?? undefined);
		this.timer = null;
	}

	private fetch(): Promise<UsageProvider[]> {
		const run = runOmp(this.omp, ["usage", "--json"]).then((stdout) => {
			let json: unknown;
			try {
				json = JSON.parse(stdout);
			} catch {
				throw new Error("omp usage --json printed invalid JSON");
			}
			const providers = parseUsageReport(json);
			this.memo = { providers, at: Date.now() };
			return providers;
		});
		const tracked = run.finally(() => {
			if (this.inflight === tracked) this.inflight = null;
		});
		this.inflight = tracked;
		return tracked;
	}

	private async sample(): Promise<void> {
		this.sampling = true;
		try {
			// OMP serves cached reports for about a minute; drop the cache so the sample reflects the turn.
			const providers = new Set(this.baseline?.map((p) => p.provider));
			for (const perAgent of this.spend.values()) for (const provider of perAgent.keys()) providers.add(provider);
			const invalidations = providers.size
				? [...providers].map((p) => runOmp(this.omp, ["usage", "invalidate", "--provider", p]))
				: [runOmp(this.omp, ["usage", "invalidate"])];
			for (const result of await Promise.allSettled(invalidations)) {
				if (result.status === "rejected") console.warn(`usage: ${errorMessage(result.reason)}`);
			}
			const spend = this.spend;
			this.spend = new Map();
			let next: UsageProvider[];
			try {
				next = await this.fetch();
			} catch (err) {
				console.warn(`usage: ${errorMessage(err)}`);
				for (const [agentId, perAgent] of spend) for (const [provider, usd] of perAgent) this.spent(agentId, provider, usd);
				return;
			}
			const prev = this.baseline;
			this.baseline = next;
			if (!prev || this.closed) return;
			const changed = attributeUsage(prev, next, spend, this.host.books());
			if (changed.size) this.host.apply(changed);
		} finally {
			this.sampling = false;
			this.lastSampleAt = Date.now();
			if (this.sampleAgain) {
				this.sampleAgain = false;
				this.requestSample();
			}
		}
	}
}

/** Whether two `resetsAt` values name the same window. Null means the window has not started. */
export function sameWindow(a: number | null, b: number | null): boolean {
	if (a === null || b === null) return a === b;
	return Math.abs(a - b) <= RESET_TOLERANCE_MS;
}

/**
 * Splits each limit's increase from `prev` to `next` across the agents in `spend`, in proportion to what each spent
 * on the limit's provider. Returns the books that changed: grown shares, and shares of windows that reset dropped.
 */
export function attributeUsage(
	prev: readonly UsageProvider[],
	next: readonly UsageProvider[],
	spend: Spend,
	books: ReadonlyMap<string, UsageBook>,
): Map<string, UsageBook> {
	const before = new Map(prev.flatMap((p) => p.limits.map((l) => [l.id, l] as const)));
	const now = new Map(next.flatMap((p) => p.limits.map((l) => [l.id, l] as const)));
	const updated = new Map<string, UsageBook>();

	for (const [agentId, book] of books) {
		let pruned: UsageBook | null = null;
		for (const [limitId, entry] of Object.entries(book)) {
			const limit = now.get(limitId);
			if (!limit || sameWindow(entry.resetsAt, limit.resetsAt)) continue;
			pruned ??= { ...book };
			delete pruned[limitId];
		}
		if (pruned) updated.set(agentId, pruned);
	}

	for (const provider of next) {
		let total = 0;
		for (const perAgent of spend.values()) total += perAgent.get(provider.provider) ?? 0;
		if (!(total > 0)) continue;
		for (const limit of provider.limits) {
			const old = before.get(limit.id);
			if (limit.usedFraction === null || old?.usedFraction == null) continue;
			// After a reset everything used so far happened in the new window.
			const delta = sameWindow(old.resetsAt, limit.resetsAt) ? limit.usedFraction - old.usedFraction : limit.usedFraction;
			if (!(delta > 0)) continue;
			for (const [agentId, perAgent] of spend) {
				const usd = perAgent.get(provider.provider) ?? 0;
				if (!(usd > 0)) continue;
				const book = { ...(updated.get(agentId) ?? books.get(agentId)) };
				const entry = book[limit.id];
				const base = entry && sameWindow(entry.resetsAt, limit.resetsAt) ? entry.share : 0;
				book[limit.id] = { share: base + (delta * usd) / total, resetsAt: limit.resetsAt };
				updated.set(agentId, book);
			}
		}
	}
	return updated;
}

/** An agent's share of every known limit in its current window; 0 when nothing was attributed in that window. */
export function currentShares(book: UsageBook | undefined, providers: readonly UsageProvider[]): Record<string, number> {
	const shares: Record<string, number> = {};
	for (const provider of providers) {
		for (const limit of provider.limits) {
			if (limit.usedFraction === null) continue;
			const entry = book?.[limit.id];
			shares[limit.id] = entry && sameWindow(entry.resetsAt, limit.resetsAt) ? Math.min(entry.share, limit.usedFraction) : 0;
		}
	}
	return shares;
}

/** `omp usage --json` output as `UsageProvider[]`, skipping malformed reports and limits. */
export function parseUsageReport(json: unknown): UsageProvider[] {
	if (!isRecord(json) || !Array.isArray(json.reports)) throw new Error("omp usage --json printed no reports");
	const generatedAt = num(json.generatedAt) ?? Date.now();
	const providers: UsageProvider[] = [];
	for (const report of json.reports) {
		if (!isRecord(report) || typeof report.provider !== "string") continue;
		const meta = isRecord(report.metadata) ? report.metadata : {};
		const limits: UsageLimit[] = [];
		for (const raw of Array.isArray(report.limits) ? report.limits : []) {
			const limit = parseLimit(raw);
			if (limit) limits.push(limit);
		}
		providers.push({
			provider: report.provider,
			account: str(meta.email) ?? str(meta.accountId),
			fetchedAt: num(report.fetchedAt) ?? generatedAt,
			limits,
		});
	}
	return providers;
}

function parseLimit(raw: unknown): UsageLimit | null {
	if (!isRecord(raw) || typeof raw.id !== "string") return null;
	const window = isRecord(raw.window) ? raw.window : {};
	const amount = isRecord(raw.amount) ? raw.amount : {};
	const used = num(amount.used);
	const limit = num(amount.limit);
	return {
		id: raw.id,
		label: str(raw.label) ?? raw.id,
		windowLabel: str(window.label),
		usedFraction: num(amount.usedFraction) ?? (used !== null && limit ? used / limit : null),
		used,
		limit,
		unit: str(amount.unit) ?? "unknown",
		resetsAt: num(window.resetsAt),
		status: str(raw.status) ?? "unknown",
	};
}

/** `get_session_stats` data, or null when it has no token counts. */
export function parseSessionStats(data: unknown): ChatStats | null {
	if (!isRecord(data) || !isRecord(data.tokens)) return null;
	const t = data.tokens;
	const input = num(t.input) ?? 0;
	const output = num(t.output) ?? 0;
	const cacheRead = num(t.cacheRead) ?? 0;
	const cacheWrite = num(t.cacheWrite) ?? 0;
	const ctx = isRecord(data.contextUsage) ? data.contextUsage : null;
	const tokens = ctx ? num(ctx.tokens) : null;
	const window = ctx ? num(ctx.contextWindow) : null;
	const percent = ctx ? num(ctx.percent) : null;
	return {
		tokens: { input, output, cacheRead, cacheWrite, total: num(t.total) ?? input + output + cacheRead + cacheWrite },
		cost: num(data.cost) ?? 0,
		context:
			tokens !== null && window
				? { tokens, window, fraction: percent !== null ? percent / 100 : tokens / window }
				: null,
	};
}

/** The model of `get_state` data, or null when it has none. */
export function parseModel(state: unknown): ChatModel | null {
	const model = isRecord(state) ? state.model : null;
	if (!isRecord(model) || typeof model.provider !== "string" || typeof model.id !== "string") return null;
	return { provider: model.provider, id: model.id, name: str(model.name) };
}

/** Runs OMP with `args` and resolves with its stdout; rejects on a non-zero exit, a spawn failure, or a timeout. */
async function runOmp(omp: string, args: string[]): Promise<string> {
	const what = `omp ${args.join(" ")}`;
	let proc: Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn([omp, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	} catch (err) {
		throw new Error(`could not run ${omp}: ${errorMessage(err)}`);
	}
	// Race rather than wait for EOF: a child left behind could hold the pipes open past the kill.
	const expired = Promise.withResolvers<null>();
	const timer = setTimeout(() => {
		proc.kill("SIGKILL");
		expired.resolve(null);
	}, RUN_TIMEOUT_MS);
	try {
		const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		const result = await Promise.race([output, expired.promise]);
		if (!result) throw new Error(`${what} did not finish within ${RUN_TIMEOUT_MS / 1000} s`);
		const [stdout, stderr, code] = result;
		if (code !== 0) {
			const detail = stderr.trim().slice(-STDERR_CHARS);
			throw new Error(`${what} exited with code ${code}${detail ? `: ${detail}` : ""}`);
		}
		return stdout;
	} finally {
		clearTimeout(timer);
	}
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}
