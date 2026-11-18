import { type ModelChoice, type ModelOption, THINKING_LEVELS, type ThinkingLevel } from "@romp/protocol";
import { isRecord } from "../util.ts";
import { runOmp } from "./usage.ts";

/** How long a listing answers `list()` without running OMP again. */
const MEMO_MS = 60_000;

/** The chat models `omp models --json` lists, memoized briefly: the list changes only when credentials or config do. */
export class ModelCatalog {
	private memo: { models: ModelOption[]; at: number } | null = null;
	private inflight: Promise<ModelOption[]> | null = null;

	constructor(private readonly omp: string) {}

	list(): Promise<ModelOption[]> {
		if (this.memo && Date.now() - this.memo.at < MEMO_MS) return Promise.resolve(this.memo.models);
		this.inflight ??= runOmp(this.omp, ["models", "--json"])
			.then((stdout) => {
				let json: unknown;
				try {
					json = JSON.parse(stdout);
				} catch {
					throw new Error("omp models --json printed invalid JSON");
				}
				const models = parseModels(json);
				this.memo = { models, at: Date.now() };
				return models;
			})
			.finally(() => {
				this.inflight = null;
			});
		return this.inflight;
	}

	/** Whether OMP lists `model`; rejects when the listing fails. */
	async has(model: { provider: string; id: string }): Promise<boolean> {
		const models = await this.list();
		return models.some((m) => m.provider === model.provider && m.id === model.id);
	}
}

/** `omp models --json` output as `ModelOption[]`, skipping malformed rows and non-chat kinds. */
export function parseModels(json: unknown): ModelOption[] {
	const rows = isRecord(json) && Array.isArray(json.models) ? json.models : [];
	return rows.flatMap((row): ModelOption[] => {
		if (!isRecord(row) || typeof row.provider !== "string" || typeof row.id !== "string") return [];
		if (row.kind !== undefined && row.kind !== "chat") return [];
		const levels = row.reasoning === true && Array.isArray(row.thinking) ? row.thinking : [];
		return [
			{
				provider: row.provider,
				id: row.id,
				name: typeof row.name === "string" && row.name !== "" ? row.name : row.id,
				thinking: THINKING_LEVELS.filter((level) => level !== "off" && levels.includes(level)),
			},
		];
	});
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** A `ModelChoice` request body, or null when it is malformed. */
export function parseChoice(value: unknown): ModelChoice | null {
	if (!isRecord(value)) return null;
	const { model, level } = value;
	if (level !== null && !isThinkingLevel(level)) return null;
	if (model === null) return { model: null, level };
	if (!isRecord(model) || typeof model.provider !== "string" || typeof model.id !== "string") return null;
	if (model.provider === "" || model.id === "") return null;
	return { model: { provider: model.provider, id: model.id }, level };
}
