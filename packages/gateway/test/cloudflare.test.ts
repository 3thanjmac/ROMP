import type { PushMessage } from "@romp/protocol";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudflareBuilds, type Fetch } from "../src/cloudflare.ts";

const ACCOUNT = "acc1";
const QUEUE = "romp-builds-ethan";

interface Call {
	method: string;
	path: string;
	body: unknown;
}

/** A fake Cloudflare API: handlers keyed by `METHOD /path` (query dropped), answering `result` or `[status, errors]`. */
function fakeApi(routes: Record<string, (body: unknown) => unknown>) {
	const calls: Call[] = [];
	const fetch: Fetch = async (url, init) => {
		const path = new URL(url).pathname.replace("/client/v4", "");
		const method = init.method ?? "GET";
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method, path, body });
		const handler = routes[`${method} ${path}`];
		if (!handler) return Response.json({ success: false, errors: [{ code: 7003, message: "No route" }] }, { status: 404 });
		const out = handler(body);
		if (Array.isArray(out) && typeof out[0] === "number") {
			return Response.json({ success: false, errors: [{ code: 1, message: out[1] }] }, { status: out[0] });
		}
		return Response.json({ success: true, errors: [], result: out });
	};
	return { fetch, calls };
}

const baseRoutes = {
	"GET /user/tokens/verify": () => ({ id: "t", status: "active" }),
	"GET /accounts": () => [{ id: ACCOUNT, name: "Ethan's account" }],
};

const dirs: string[] = [];
let service: CloudflareBuilds | null = null;
afterEach(async () => {
	service?.stop();
	service = null;
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function make(routes: Record<string, (body: unknown) => unknown>, notices: PushMessage[] = []) {
	const dir = await mkdtemp(join(tmpdir(), "romp-cf-"));
	dirs.push(dir);
	const api = fakeApi(routes);
	service = new CloudflareBuilds(dir, "Ethan", (m) => notices.push(m), api.fetch, 60_000);
	return { service, api, dir, notices };
}

/** Turns the event loop until `check` holds; the service reads the queue on a zero-delay timer after connecting. */
const until = async (check: () => boolean) => {
	for (let i = 0; i < 1000 && !check(); i++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
	expect(check()).toBe(true);
};

const pollError = (service: CloudflareBuilds) => {
	const status = service.status();
	return status.connected ? status.pollError : undefined;
};

test("connect creates the user's queue with an HTTP pull consumer and saves the token privately", async () => {
	const { service, api, dir } = await make({
		...baseRoutes,
		"GET /accounts/acc1/queues": () => [{ queue_id: "other", queue_name: "romp-builds-alice" }],
		"POST /accounts/acc1/queues": () => ({ queue_id: "q1", queue_name: QUEUE }),
		"GET /accounts/acc1/queues/q1/consumers": () => [],
		"POST /accounts/acc1/queues/q1/consumers": () => ({ consumer_id: "c1", type: "http_pull" }),
		"POST /accounts/acc1/queues/q1/messages/pull": () => ({ messages: [] }),
	});
	expect(await service.connect("  tok  ")).toEqual({
		connected: true,
		accountName: "Ethan's account",
		queueName: QUEUE,
		pollError: null,
	});
	expect(api.calls.find((c) => c.method === "POST" && c.path.endsWith("/queues"))?.body).toEqual({ queue_name: QUEUE });
	expect(api.calls.find((c) => c.path.endsWith("/consumers") && c.method === "POST")?.body).toEqual({ type: "http_pull" });
	const saved = JSON.parse(await readFile(join(dir, "cloudflare.json"), "utf8"));
	expect(saved).toMatchObject({ token: "tok", accountId: ACCOUNT, queueId: "q1", queueName: QUEUE });
	if (process.platform !== "win32") expect((await Bun.file(join(dir, "cloudflare.json")).stat()).mode & 0o777).toBe(0o600);
});

test("connect refuses a token that reaches several accounts, and one Cloudflare rejects", async () => {
	const several = await make({ ...baseRoutes, "GET /accounts": () => [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
	await expect(several.service.connect("tok")).rejects.toThrow("reaches 2 accounts (A, B)");
	const bad = await make({ "GET /user/tokens/verify": () => [401, "Invalid API Token"] });
	await expect(bad.service.connect("tok")).rejects.toThrow("Cloudflare didn't accept this token (Invalid API Token)");
	expect(bad.service.status()).toEqual({ connected: false });
});

test("build events from the queue become notices that open the build, and every pulled message is acknowledged", async () => {
	const event = (type: string, worker: string) => ({
		body: Buffer.from(
			JSON.stringify({
				type,
				source: { type: "workersBuilds.worker", workerName: worker },
				payload: {
					buildUuid: "build-1",
					buildTriggerMetadata: { branch: "main", commitMessage: "Fix auth\n\nLonger description" },
				},
			}),
		).toString("base64"),
		metadata: { "CF-Content-Type": "json" },
	});
	let pulled = false;
	const { service, api, notices } = await make({
		...baseRoutes,
		"GET /accounts/acc1/queues": () => [{ queue_id: "q1", queue_name: QUEUE }],
		"GET /accounts/acc1/queues/q1/consumers": () => [{ type: "http_pull" }],
		"POST /accounts/acc1/queues/q1/messages/pull": () => {
			if (pulled) return { messages: [] };
			pulled = true;
			return {
				message_backlog_count: 0,
				messages: [
					{ ...event("cf.workersBuilds.worker.build.failed", "my worker"), id: "m1", lease_id: "l1" },
					{ ...event("cf.workersBuilds.worker.build.started", "my worker"), id: "m2", lease_id: "l2" },
					{ body: "not json", metadata: {}, id: "m3", lease_id: "l3" },
				],
			};
		},
		"POST /accounts/acc1/queues/q1/messages/ack": () => ({ ackCount: 3 }),
	});
	await service.connect("tok");
	await until(() => api.calls.some((c) => c.path.endsWith("/ack")));
	expect(notices).toEqual([
		{
			title: "my worker build failed",
			body: "main · Fix auth",
			tag: "build-my worker",
			agentId: null,
			cwd: null,
			url: "https://dash.cloudflare.com/acc1/workers/services/view/my%20worker/production/builds/build-1",
		},
	]);
	expect(api.calls.find((c) => c.path.endsWith("/ack"))?.body).toEqual({
		acks: [{ lease_id: "l1" }, { lease_id: "l2" }, { lease_id: "l3" }],
		retries: [],
	});
});

test("a failing queue read is reported in the status until a read succeeds", async () => {
	let fail = true;
	const { service } = await make({
		...baseRoutes,
		"GET /accounts/acc1/queues": () => [{ queue_id: "q1", queue_name: QUEUE }],
		"GET /accounts/acc1/queues/q1/consumers": () => [{ type: "http_pull" }],
		"POST /accounts/acc1/queues/q1/messages/pull": () => (fail ? [403, "Authentication error"] : { messages: [] }),
	});
	await service.connect("tok");
	await until(() => pollError(service) != null);
	expect(pollError(service)).toBe("Authentication error");
	fail = false;
	// The next read waits out the backoff, so reconnect to read at once.
	await service.connect("tok");
	await until(() => pollError(service) === null);
});

test("workers lists repos from Workers Builds and marks the ones routed to this user's queue", async () => {
	const { service, api } = await make({
		...baseRoutes,
		"GET /accounts/acc1/queues": () => [{ queue_id: "q1", queue_name: QUEUE }],
		"GET /accounts/acc1/queues/q1/consumers": () => [{ type: "http_pull" }],
		"POST /accounts/acc1/queues/q1/messages/pull": () => ({ messages: [] }),
		"GET /accounts/acc1/workers/scripts": () => [
			{ id: "site", tag: "t-site" },
			{ id: "api", tag: "t-api" },
			{ id: "cron", tag: "t-cron" },
		],
		"GET /accounts/acc1/builds/workers/t-site": () => ({
			git_repository: { provider_account_name: "ethan", repo_name: "site", branch: "main" },
		}),
		"GET /accounts/acc1/builds/workers/t-api": () => ({
			git_repository: { provider_account_name: "ethan", repo_name: "api", branch: "prod" },
		}),
		"GET /accounts/acc1/builds/workers/t-cron": () => [404, "Not found"],
		"GET /accounts/acc1/event_subscriptions/subscriptions": () => [
			{ id: "s1", source: { type: "workersBuilds.worker", worker_name: "site" }, destination: { type: "queues.queue", queue_id: "q1" } },
			{ id: "s2", source: { type: "workersBuilds.worker", worker_name: "api" }, destination: { type: "queues.queue", queue_id: "other" } },
		],
		"POST /accounts/acc1/event_subscriptions/subscriptions": () => ({ id: "s3" }),
		"DELETE /accounts/acc1/event_subscriptions/subscriptions/s1": () => ({ id: "s1" }),
	});
	await service.connect("tok");
	expect(await service.workers()).toEqual([
		{ name: "api", repository: { owner: "ethan", name: "api", branch: "prod" }, subscribed: false },
		{ name: "cron", repository: null, subscribed: false },
		{ name: "site", repository: { owner: "ethan", name: "site", branch: "main" }, subscribed: true },
	]);

	const subscriptionCalls = () => api.calls.filter((c) => c.path.includes("/event_subscriptions/") && c.method !== "GET");
	await service.setWorker("api", true);
	expect(subscriptionCalls()).toEqual([
		{
			method: "POST",
			path: "/accounts/acc1/event_subscriptions/subscriptions",
			body: {
				enabled: true,
				events: ["build.succeeded", "build.failed", "build.canceled"],
				source: { type: "workersBuilds.worker", worker_name: "api" },
				destination: { type: "queues.queue", queue_id: "q1" },
			},
		},
	]);
	await service.setWorker("site", false);
	expect(subscriptionCalls().at(-1)).toMatchObject({ method: "DELETE", path: "/accounts/acc1/event_subscriptions/subscriptions/s1" });
	// The fake still lists s1 for "site", so turning it on again creates nothing.
	await service.setWorker("site", true);
	expect(subscriptionCalls()).toHaveLength(2);
});

test("disconnect forgets the token even when Cloudflare refuses the cleanup, and says what is left", async () => {
	const { service, dir } = await make({
		...baseRoutes,
		"GET /accounts/acc1/queues": () => [{ queue_id: "q1", queue_name: QUEUE }],
		"GET /accounts/acc1/queues/q1/consumers": () => [{ type: "http_pull" }],
		"POST /accounts/acc1/queues/q1/messages/pull": () => ({ messages: [] }),
		"GET /accounts/acc1/event_subscriptions/subscriptions": () => [403, "Authentication error"],
	});
	await service.connect("tok");
	const { leftover } = await service.disconnect();
	expect(leftover).toContain(`remove the queue ${QUEUE}`);
	expect(service.status()).toEqual({ connected: false });
	expect(await Bun.file(join(dir, "cloudflare.json")).exists()).toBe(false);
});
