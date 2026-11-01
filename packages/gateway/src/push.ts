import type { PushMessage, PushSubscriptionInput } from "@romp/protocol";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError, badRequest, notFound } from "./http.ts";
import { errnoCode, errorMessage, isRecord, writeFileAtomic } from "./util.ts";
import { fromBase64url, generateVapidKeys, sendPush, Vapid, type VapidKeys } from "./webpush.ts";

interface StoredSubscription {
	endpoint: string;
	p256dh: string;
	auth: string;
	/** VAPID `sub` claim: the `https://` origin the device subscribed from. */
	subject: string;
	createdAt: number;
}

interface PushFile {
	vapid: VapidKeys;
	subscriptions: StoredSubscription[];
}

/** Devices per user; the oldest subscription is dropped beyond this. */
const MAX_SUBSCRIPTIONS = 20;
/** A device counts as watching for this long after its last presence report (the client reports every 15 s). */
const PRESENCE_MS = 40_000;
/** How long a push service keeps a message for a device that is off or unreachable. */
const TTL_SECONDS = 24 * 60 * 60;

/**
 * Web Push for one gateway user: the VAPID key pair and the devices that subscribed, stored at
 * `<state_dir>/push.json`, plus which devices currently have ROMP in front of the user (those are skipped).
 */
export class PushService {
	private readonly file: string;
	private keys: VapidKeys | null = null;
	private vapid: Vapid | null = null;
	private subscriptions: StoredSubscription[] = [];
	/** Endpoint → time its presence lapses. */
	private readonly present = new Map<string, number>();
	private saving: Promise<void> = Promise.resolve();

	constructor(private readonly stateDir: string) {
		this.file = join(stateDir, "push.json");
	}

	/** Reads `push.json`, creating the VAPID key pair on first run. */
	async load(): Promise<void> {
		let saved: PushFile | null = null;
		try {
			const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
			if (isPushFile(parsed)) saved = parsed;
			else console.warn(`${this.file}: malformed, starting over with new keys`);
		} catch (err) {
			if (errnoCode(err) !== "ENOENT") console.warn(`${this.file}: ${errorMessage(err)}; starting over with new keys`);
		}
		if (saved) {
			this.keys = saved.vapid;
			this.subscriptions = saved.subscriptions;
		} else {
			// Subscriptions are bound to the key they were made with, so none survive new keys.
			this.keys = await generateVapidKeys();
			this.subscriptions = [];
			this.persist();
		}
		this.vapid = await Vapid.load(this.keys);
	}

	get publicKey(): string {
		return this.ready().publicKey;
	}

	/** Adds or refreshes a device. `origin` is the `https://host` the app was opened at. */
	subscribe(input: PushSubscriptionInput, origin: string): void {
		const existing = this.subscriptions.find((s) => s.endpoint === input.endpoint);
		const record: StoredSubscription = {
			endpoint: input.endpoint,
			p256dh: input.keys.p256dh,
			auth: input.keys.auth,
			subject: origin,
			createdAt: existing?.createdAt ?? Date.now(),
		};
		if (
			existing &&
			existing.p256dh === record.p256dh &&
			existing.auth === record.auth &&
			existing.subject === record.subject
		) {
			return;
		}
		this.subscriptions = [...this.subscriptions.filter((s) => s.endpoint !== input.endpoint), record].slice(-MAX_SUBSCRIPTIONS);
		this.persist();
	}

	unsubscribe(endpoint: string): void {
		this.present.delete(endpoint);
		const kept = this.subscriptions.filter((s) => s.endpoint !== endpoint);
		if (kept.length === this.subscriptions.length) return;
		this.subscriptions = kept;
		this.persist();
	}

	/** Marks a device as watching ROMP (no pushes) or not. Unknown endpoints are ignored. */
	setPresence(endpoint: string, active: boolean): void {
		if (!active) this.present.delete(endpoint);
		else if (this.subscriptions.some((s) => s.endpoint === endpoint)) this.present.set(endpoint, Date.now() + PRESENCE_MS);
	}

	/** Sends `message` to every subscribed device that is not watching ROMP right now. Never throws. */
	notify(message: PushMessage): void {
		const now = Date.now();
		const targets = this.subscriptions.filter((s) => (this.present.get(s.endpoint) ?? 0) <= now);
		for (const target of targets) {
			void this.send(target, message).then(
				(error) => error && console.warn(`push to ${new URL(target.endpoint).host}: ${error}`),
				(err: unknown) => console.warn(`push to ${new URL(target.endpoint).host}: ${errorMessage(err)}`),
			);
		}
	}

	/** Sends a test notification to one device, throwing with the push service's answer when it fails. */
	async test(endpoint: string): Promise<void> {
		const target = this.subscriptions.find((s) => s.endpoint === endpoint);
		if (!target) throw notFound("This device is not subscribed; turn notifications on again");
		let error: string | null;
		try {
			error = await this.send(target, {
				title: "ROMP",
				body: "Notifications are working. You'll hear from your agents here.",
				tag: "test",
				agentId: null,
				cwd: null,
			});
		} catch (err) {
			throw new HttpError(502, "push_failed", `Couldn't reach the push service: ${errorMessage(err)}`);
		}
		if (error) throw new HttpError(502, "push_failed", error);
	}

	/** Waits for pending writes; call before exiting. */
	flush(): Promise<void> {
		return this.saving;
	}

	/** Resolves with the push service's refusal, or null when it accepted the message. */
	private async send(target: StoredSubscription, message: PushMessage): Promise<string | null> {
		const result = await sendPush(this.ready(), target, JSON.stringify(message), TTL_SECONDS);
		if (result.expired) this.unsubscribe(target.endpoint);
		return result.error;
	}

	private ready(): Vapid {
		if (!this.vapid) throw new Error("PushService.load() has not finished");
		return this.vapid;
	}

	private persist(): void {
		const data: PushFile = { vapid: this.keys as VapidKeys, subscriptions: this.subscriptions };
		this.saving = this.saving
			.then(async () => {
				await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
				await writeFileAtomic(this.file, `${JSON.stringify(data, null, "\t")}\n`, 0o600);
			})
			.catch((err: unknown) => console.error(`saving ${this.file}: ${errorMessage(err)}`));
	}
}

/** Validates a browser `PushSubscription.toJSON()` body. */
export function parseSubscription(body: Record<string, unknown>): PushSubscriptionInput {
	const endpoint = parseEndpoint(body);
	const keys = body.keys;
	if (!isRecord(keys) || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
		throw badRequest(`"keys" must hold the subscription's p256dh and auth strings`);
	}
	if (fromBase64url(keys.p256dh).length !== 65 || fromBase64url(keys.auth).length !== 16) {
		throw badRequest(`"keys" are not a P-256 public key and 16-byte auth secret`);
	}
	return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/** The `endpoint` of a request body: a push service URL. */
export function parseEndpoint(body: Record<string, unknown>): string {
	const endpoint = body.endpoint;
	if (typeof endpoint !== "string" || endpoint.length > 2048 || !URL.canParse(endpoint) || !endpoint.startsWith("https://")) {
		throw badRequest(`"endpoint" must be an https push service URL`);
	}
	return endpoint;
}

function isPushFile(value: unknown): value is PushFile {
	return (
		isRecord(value) &&
		isRecord(value.vapid) &&
		typeof value.vapid.publicKey === "string" &&
		isRecord(value.vapid.privateJwk) &&
		Array.isArray(value.subscriptions) &&
		value.subscriptions.every(
			(s) =>
				isRecord(s) &&
				typeof s.endpoint === "string" &&
				typeof s.p256dh === "string" &&
				typeof s.auth === "string" &&
				typeof s.subject === "string" &&
				typeof s.createdAt === "number",
		)
	);
}
