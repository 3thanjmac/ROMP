import type { CloudflareDisconnected, CloudflareStatus, CloudflareWorker, PushMessage } from "@romp/protocol";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { HttpError, badRequest, conflict } from "./http.ts";
import { errnoCode, errorMessage, isRecord, writeFileAtomic } from "./util.ts";

const API = "https://api.cloudflare.com/client/v4";
/** How often the queue is read while it is empty. */
const POLL_MS = 5_000;
/** Longest wait between reads after repeated failures. */
const MAX_BACKOFF_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** Workers Builds events the subscriptions ask for; `build.started` is left out. */
const EVENTS = ["build.succeeded", "build.failed", "build.canceled"];
const OUTCOMES: Record<string, string> = { succeeded: "succeeded", failed: "failed", canceled: "was canceled" };
/** Parallel build-settings lookups when listing Workers. */
const LOOKUPS = 6;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface Saved {
	token: string;
	accountId: string;
	accountName: string;
	queueId: string;
	queueName: string;
}

/** A failed Cloudflare API call. Answers the browser with 502 and Cloudflare's own message. */
export class CloudflareError extends HttpError {
	constructor(
		/** Cloudflare's HTTP status; 0 when it could not be reached. */
		readonly upstream: number,
		message: string,
	) {
		super(502, "cloudflare_error", message);
	}
}

/** A Workers Builds event as it arrives from the queue. */
export interface BuildEvent {
	type: string;
	source: { workerName: string };
	payload: {
		buildUuid?: string;
		buildTriggerMetadata?: { branch?: string; commitMessage?: string } | null;
	};
}

/**
 * Cloudflare Workers Builds notifications for one gateway user. The token and the user's queue live in
 * `<state_dir>/cloudflare.json`. Event subscriptions route the builds of chosen Workers into the queue, and this
 * service pulls it over HTTP, so nothing on the VM has to be reachable from the internet.
 */
export class CloudflareBuilds {
	private readonly file: string;
	private saved: Saved | null = null;
	private pollError: string | null = null;
	private failures = 0;
	private timer: Timer | undefined;
	/** Bumped on connect and disconnect so a read in flight for the old connection drops its result. */
	private generation = 0;
	/** Connect, disconnect and subscription changes run one at a time. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		stateDir: string,
		/** Linux user, part of the queue name so people sharing a Cloudflare account get separate queues. */
		private readonly user: string,
		private readonly notify: (message: PushMessage) => void,
		private readonly fetch: Fetch = (url, init) => globalThis.fetch(url, init),
		private readonly pollMs = POLL_MS,
	) {
		this.file = join(stateDir, "cloudflare.json");
	}

	/** Reads `cloudflare.json` and starts reading the queue when connected. */
	async load(): Promise<void> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
			if (isSaved(parsed)) this.saved = parsed;
			else console.warn(`${this.file}: malformed, ignoring it`);
		} catch (err) {
			if (errnoCode(err) !== "ENOENT") console.warn(`${this.file}: ${errorMessage(err)}`);
		}
		if (this.saved) this.schedule(0);
	}

	status(): CloudflareStatus {
		const s = this.saved;
		return s
			? { connected: true, accountName: s.accountName, queueName: s.queueName, pollError: this.pollError }
			: { connected: false };
	}

	/** Checks `token`, creates the user's queue with an HTTP pull consumer (or reuses it), and starts reading it. */
	connect(token: string): Promise<CloudflareStatus> {
		return this.serial(async () => {
			const trimmed = token.trim();
			if (!trimmed) throw badRequest("Paste a Cloudflare API token");
			let verified: unknown;
			try {
				verified = await this.call(trimmed, "GET", "/user/tokens/verify");
			} catch (err) {
				if (!(err instanceof CloudflareError) || err.upstream === 0) throw err;
				throw badRequest(
					`Cloudflare didn't accept this token (${err.message}). Create a user API token under My Profile → API Tokens.`,
				);
			}
			const state = isRecord(verified) ? verified.status : undefined;
			if (state !== "active") throw badRequest(`This token is ${String(state ?? "not active")}; create a new one`);

			const accounts = (await this.list(trimmed, "/accounts", 50)).filter(isRecord);
			if (accounts.length === 0) throw badRequest("This token can't reach any Cloudflare account; give it account permissions");
			if (accounts.length > 1) {
				const names = accounts.map((a) => String(a.name)).join(", ");
				throw badRequest(`This token reaches ${accounts.length} accounts (${names}). Edit it to include only the one your Workers are in.`);
			}
			const account = accounts[0] ?? {};
			const accountId = String(account.id);
			const queueName = queueNameFor(this.user);
			const queuesPath = `/accounts/${accountId}/queues`;
			const queues = (await this.list(trimmed, queuesPath, 100, "Queues · Edit")).filter(isRecord);
			let queue = queues.find((q) => q.queue_name === queueName);
			queue ??= asRecord(await this.call(trimmed, "POST", queuesPath, { queue_name: queueName }, "Queues · Edit"));
			const queueId = String(queue.queue_id);
			const consumers = (await this.list(trimmed, `${queuesPath}/${queueId}/consumers`, 100)).filter(isRecord);
			if (consumers.some((c) => c.type === "worker")) {
				throw conflict(`The queue ${queueName} already has a Worker consumer. Remove it in the Cloudflare dashboard, then connect again.`);
			}
			if (!consumers.some((c) => c.type === "http_pull")) {
				await this.call(trimmed, "POST", `${queuesPath}/${queueId}/consumers`, { type: "http_pull" });
			}

			this.stop();
			this.saved = { token: trimmed, accountId, accountName: String(account.name ?? accountId), queueId, queueName };
			this.pollError = null;
			this.failures = 0;
			await writeFileAtomic(this.file, `${JSON.stringify(this.saved, null, "\t")}\n`, 0o600);
			this.schedule(0);
			return this.status();
		});
	}

	/** Deletes the subscriptions and the queue, then forgets the token. Forgets it even when Cloudflare refuses. */
	disconnect(): Promise<CloudflareDisconnected> {
		return this.serial(async () => {
			const s = this.saved;
			if (!s) return { leftover: null };
			this.stop();
			let leftover: string | null = null;
			try {
				for (const id of (await this.subscriptions(s)).values()) {
					await this.call(s.token, "DELETE", `/accounts/${s.accountId}/event_subscriptions/subscriptions/${id}`).catch(ignoreMissing);
				}
				await this.call(s.token, "DELETE", `/accounts/${s.accountId}/queues/${s.queueId}`).catch(ignoreMissing);
			} catch (err) {
				leftover = `ROMP couldn't remove the queue ${s.queueName} from Cloudflare (${errorMessage(err)}). Delete it under Storage & databases → Queues.`;
			}
			this.saved = null;
			this.pollError = null;
			await rm(this.file, { force: true });
			return { leftover };
		});
	}

	/** The account's Workers, with the repo each builds from and whether its builds reach the queue. */
	async workers(): Promise<CloudflareWorker[]> {
		const s = this.connected();
		const [scripts, subscribed] = await Promise.all([
			this.list(s.token, `/accounts/${s.accountId}/workers/scripts`, 100, "Workers Scripts · Read"),
			this.subscriptions(s),
		]);
		const named = scripts.filter(isRecord).filter((w) => typeof w.id === "string" && w.id !== "");
		const repos = await mapLimit(named, LOOKUPS, (w) => (typeof w.tag === "string" ? this.repository(s, w.tag) : Promise.resolve(null)));
		return named
			.map((w, i) => ({ name: String(w.id), repository: repos[i] ?? null, subscribed: subscribed.has(String(w.id)) }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Subscribes the queue to a Worker's build events, or removes that subscription. Repeating a change is harmless. */
	setWorker(name: string, subscribed: boolean): Promise<void> {
		return this.serial(async () => {
			const s = this.connected();
			const existing = (await this.subscriptions(s)).get(name);
			const path = `/accounts/${s.accountId}/event_subscriptions/subscriptions`;
			if (subscribed && !existing) {
				await this.call(
					s.token,
					"POST",
					path,
					{
						// Documented as optional, but the API answers "Required at name" without it. Wrangler's default
						// is "<queue> <source>"; the Worker name keeps each one recognizable in the dashboard.
						name: `${s.queueName} ${name}`,
						enabled: true,
						events: EVENTS,
						source: { type: "workersBuilds.worker", worker_name: name },
						destination: { type: "queues.queue", queue_id: s.queueId },
					},
					"Queues · Edit",
				);
			} else if (!subscribed && existing) {
				await this.call(s.token, "DELETE", `${path}/${existing}`).catch(ignoreMissing);
			}
		});
	}

	/** Stops reading the queue; call before exiting. */
	stop(): void {
		this.generation++;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private schedule(ms: number): void {
		const generation = this.generation;
		this.timer = setTimeout(() => void this.poll(generation), ms);
	}

	/** Pulls one batch, notifies for each build event, acknowledges the batch, and schedules the next read. */
	private async poll(generation: number): Promise<void> {
		const s = this.saved;
		if (!s || generation !== this.generation) return;
		let next = this.pollMs;
		try {
			const base = `/accounts/${s.accountId}/queues/${s.queueId}/messages`;
			const batch = asRecord(await this.call(s.token, "POST", `${base}/pull`, { batch_size: 20, visibility_timeout_ms: 60_000 }));
			if (generation !== this.generation) return;
			const messages = Array.isArray(batch.messages) ? batch.messages.filter(isRecord) : [];
			for (const m of messages) {
				const event = decodeEvent(m);
				const message = event && buildNotice(event, s.accountId);
				if (message) this.notify(message);
				else if (!event) console.warn(`cloudflare: skipping an unreadable queue message ${String(m.id)}`);
			}
			const acks = messages.filter((m) => typeof m.lease_id === "string").map((m) => ({ lease_id: m.lease_id }));
			if (acks.length > 0) await this.call(s.token, "POST", `${base}/ack`, { acks, retries: [] });
			this.pollError = null;
			this.failures = 0;
			// More waiting behind a full batch: read again right away.
			if (messages.length > 0 && Number(batch.message_backlog_count) > 0) next = 0;
		} catch (err) {
			if (generation !== this.generation) return;
			this.failures++;
			if (this.pollError === null) console.warn(`cloudflare: reading ${s.queueName} failed: ${errorMessage(err)}`);
			this.pollError = errorMessage(err);
			next = Math.min(this.pollMs * 2 ** this.failures, MAX_BACKOFF_MS);
		}
		if (generation === this.generation) this.schedule(next);
	}

	/** Worker name → id of the subscription that routes its builds into the user's queue. */
	private async subscriptions(s: Saved): Promise<Map<string, string>> {
		const all = await this.list(s.token, `/accounts/${s.accountId}/event_subscriptions/subscriptions`, 100, "Queues · Edit");
		const mine = new Map<string, string>();
		for (const sub of all.filter(isRecord)) {
			const { source, destination } = sub;
			if (!isRecord(source) || !isRecord(destination) || destination.queue_id !== s.queueId) continue;
			if (source.type === "workersBuilds.worker" && typeof source.worker_name === "string") mine.set(source.worker_name, String(sub.id));
		}
		return mine;
	}

	/** The Git repo Workers Builds builds this Worker from, or null when it has none. */
	private async repository(s: Saved, tag: string): Promise<CloudflareWorker["repository"]> {
		let config: unknown;
		try {
			config = await this.call(s.token, "GET", `/accounts/${s.accountId}/builds/workers/${tag}`, undefined, "Workers Builds Configuration · Read");
		} catch (err) {
			if (err instanceof CloudflareError && err.upstream === 404) return null;
			throw err;
		}
		const repo = isRecord(config) ? config.git_repository : null;
		if (!isRecord(repo) || typeof repo.repo_name !== "string") return null;
		return {
			owner: typeof repo.provider_account_name === "string" ? repo.provider_account_name : "",
			name: repo.repo_name,
			branch: typeof repo.branch === "string" ? repo.branch : "",
		};
	}

	private connected(): Saved {
		if (!this.saved) throw conflict("Cloudflare builds are not connected");
		return this.saved;
	}

	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => { });
		return run;
	}

	/** Every page of a list endpoint. */
	private async list(token: string, path: string, perPage: number, permission?: string): Promise<unknown[]> {
		const items: unknown[] = [];
		for (let page = 1; ; page++) {
			const sep = path.includes("?") ? "&" : "?";
			const { result, info } = await this.request(token, "GET", `${path}${sep}page=${page}&per_page=${perPage}`, undefined, permission);
			if (!Array.isArray(result)) break;
			items.push(...result);
			const pages = isRecord(info) ? Number(info.total_pages) : Number.NaN;
			if (!(page < pages) || result.length === 0) break;
		}
		return items;
	}

	private async call(token: string, method: string, path: string, body?: unknown, permission?: string): Promise<unknown> {
		return (await this.request(token, method, path, body, permission)).result;
	}

	/** One API request; Cloudflare's error messages become a `CloudflareError`, naming the permission a 403 lacks. */
	private async request(
		token: string,
		method: string,
		path: string,
		body: unknown,
		permission: string | undefined,
	): Promise<{ result: unknown; info: unknown }> {
		let res: Response;
		try {
			res = await this.fetch(`${API}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (err) {
			throw new CloudflareError(0, `Couldn't reach Cloudflare: ${errorMessage(err)}`);
		}
		let data: unknown = null;
		try {
			data = await res.json();
		} catch {
			// A non-JSON answer (a proxy's error page) is reported by status below.
		}
		const envelope = isRecord(data) ? data : {};
		if (res.ok && envelope.success !== false) return { result: envelope.result, info: envelope.result_info };
		const errors = Array.isArray(envelope.errors) ? envelope.errors.filter(isRecord) : [];
		let message = errors.map((e) => String(e.message ?? e.code)).join("; ") || `HTTP ${res.status}`;
		if ((res.status === 401 || res.status === 403) && permission) {
			message += `. Check that the token is still valid and has ${permission}`;
		}
		throw new CloudflareError(res.status, message);
	}
}

/** `romp-builds-<user>`: queue names allow lowercase letters, digits and dashes. */
export function queueNameFor(user: string): string {
	const slug = user
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug ? `romp-builds-${slug}` : "romp-builds";
}

/** Reads a pulled message. `json` and `bytes` bodies arrive base64-encoded, `text` ones as plain text. */
export function decodeEvent(message: Record<string, unknown>): BuildEvent | null {
	if (typeof message.body !== "string") return null;
	const meta = isRecord(message.metadata) ? message.metadata : {};
	const text = meta["CF-Content-Type"] === "text" ? message.body : Buffer.from(message.body, "base64").toString("utf8");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		try {
			value = JSON.parse(message.body);
		} catch {
			return null;
		}
	}
	if (!isRecord(value) || typeof value.type !== "string") return null;
	if (!isRecord(value.source) || typeof value.source.workerName !== "string" || !isRecord(value.payload)) return null;
	return value as unknown as BuildEvent;
}

/** The notification for a finished build; null for other events. Tapping it opens the build in the dashboard. */
export function buildNotice(event: BuildEvent, accountId: string): PushMessage | null {
	const prefix = "cf.workersBuilds.worker.build.";
	if (!event.type.startsWith(prefix)) return null;
	const outcome = OUTCOMES[event.type.slice(prefix.length)];
	if (!outcome) return null;
	const worker = event.source.workerName;
	const meta = event.payload.buildTriggerMetadata;
	const commit = meta?.commitMessage?.split("\n", 1)[0]?.trim();
	const uuid = event.payload.buildUuid;
	return {
		title: `${worker} build ${outcome}`,
		body: [meta?.branch, commit].filter(Boolean).join(" · "),
		tag: `build-${worker}`,
		agentId: null,
		cwd: null,
		url: uuid
			? `https://dash.cloudflare.com/${accountId}/workers/services/view/${encodeURIComponent(worker)}/production/builds/${uuid}`
			: null,
	};
}

function ignoreMissing(err: unknown): void {
	if (!(err instanceof CloudflareError && err.upstream === 404)) throw err;
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new CloudflareError(502, "Cloudflare sent an unexpected answer");
	return value;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

function isSaved(value: unknown): value is Saved {
	return (
		isRecord(value) &&
		["token", "accountId", "accountName", "queueId", "queueName"].every((key) => typeof value[key] === "string")
	);
}
