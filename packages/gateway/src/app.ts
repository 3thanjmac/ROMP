import {
	addRepo,
	clearRepoEnv,
	createTask,
	getTask,
	listRepos,
	listTasks,
	readGitIdentity,
	removeRepo,
	removeTask,
	renameTask,
	repoBranches,
	resolveDevCommand,
	type RompEnv,
	setRepoEnv,
	shipTask,
	taskForPath,
	updateRepoSettings,
	writeGitIdentity,
} from "@romp/core";
import {
	type AgentClientMsg,
	type DevCommand,
	type GitIdentity,
	type ListeningPort,
	isRepoColor,
	MAX_ENV_BYTES,
	type Me,
	type ModelChoice,
	type PushConfig,
	type TaskCreated,
	type TaskInfo,
	type TermClientMsg,
	parseLoopbackCallback,
	REPO_COLORS,
	THINKING_LEVELS,
} from "@romp/protocol";
import type { Server, WebSocketHandler } from "bun";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentManager } from "./agents/manager.ts";
import { parseChoice } from "./agents/models.ts";
import type { TitleGenerator } from "./agents/title.ts";
import { deliverCallback } from "./callback.ts";
import { type Auth, crossOriginError, type Identity } from "./auth.ts";
import type { CloudflareBuilds } from "./cloudflare.ts";
import type { GatewayConfig } from "./config.ts";
import type { DevServerManager } from "./devservers.ts";
import { type Files, parseFsOp } from "./files.ts";
import type { RepoSearch } from "./github.ts";
import {
	HttpError,
	badRequest,
	forbidden,
	json,
	noContent,
	notFound,
	optionalString,
	readBytes,
	readJson,
	requireInt,
	requireOctetStream,
	requireString,
	toErrorResponse,
} from "./http.ts";
import type { Roots } from "./paths.ts";
import { listeningSockets, socketProcessNames } from "./procnet.ts";
import { parseEndpoint, parseSubscription, type PushService } from "./push.ts";
import {
	checkPort,
	cookieProxyPort,
	loopbackHost,
	parseProxyPath,
	prefixedTarget,
	proxyHttp,
	proxySocket,
	proxyWebSocket,
	refererProxyPort,
} from "./proxy.ts";
import { Router } from "./router.ts";
import { type LanSessions, sessionCookie, sessionCookieName } from "./sessions.ts";
import { MAX_STATE_BYTES, type ShellStateStore } from "./shellstate.ts";
import { serveStatic } from "./static.ts";
import { TaskSetups } from "./tasksetup.ts";
import type { TerminalManager } from "./terminals.ts";
import type { Updates } from "./updates.ts";
import { errorMessage, isRecord } from "./util.ts";
import type { Socket, WsData } from "./ws.ts";

const isApiPath = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");

export interface AppDeps {
	cfg: GatewayConfig;
	roots: Roots;
	/** Realpath of the gateway user's home. */
	home: string;
	user: string;
	host: string;
	auth: Auth;
	files: Files;
	terms: TerminalManager;
	dev: DevServerManager;
	agents: AgentManager;
	shellState: ShellStateStore;
	sessions: LanSessions;
	push: PushService;
	cloudflare: CloudflareBuilds;
	romp: RompEnv;
	/** Background titles for tasks created with `autoTitle`. */
	titles: TitleGenerator;
	repoSearch: RepoSearch;
	updates: Updates;
}

interface Ctx {
	req: Request;
	url: URL;
	identity: Identity;
}

const SMALL_BODY = 64 * 1024;
/** 5 MiB of text can double when JSON-escaped. */
const WRITE_BODY = 12 * 1024 * 1024;

export function createApp(deps: AppDeps) {
	const router = buildRouter(deps);

	async function fetch(req: Request, server: Server<WsData>): Promise<Response | undefined> {
		const url = new URL(req.url);
		try {
			const originError = crossOriginError(req);
			if (originError) throw forbidden(originError);
			const caller = deps.auth.identify(req, server);
			if (caller.lan && url.pathname === "/api/login") {
				if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
				const token = await deps.sessions.login(requireString(await readJson(req, SMALL_BODY), "password"));
				return new Response(null, {
					status: 204,
					headers: { "cache-control": "no-store", "set-cookie": sessionCookie(sessionCookieName(req), token) },
				});
			}
			const identity = caller.identity;
			// Before signing in, a LAN browser may load the app itself (so it can show the sign-in screen) and nothing else.
			if (
				identity === null &&
				(isApiPath(url.pathname) || url.pathname.startsWith("/ws/") || parseProxyPath(url.pathname, url.search) !== null)
			) {
				throw new HttpError(401, "login_required", "Sign in to continue.");
			}
			const isUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";

			const proxy = identity === null ? null : parseProxyPath(url.pathname, url.search);
			if (proxy) {
				if ("redirect" in proxy) return new Response(null, { status: 308, headers: { location: proxy.redirect } });
				checkPort(proxy.target, deps.cfg.listen.port);
				const host = loopbackHost(proxy.target.port, listeningSockets());
				return isUpgrade
					? await proxyWebSocket(req, url, proxy.target, host, server)
					: await proxyHttp(req, url, proxy.target, host);
			}
			if (identity !== null) {
				// A page under /proxy/<port>/ asking for a root-absolute path: send it back under its prefix. ROMP's own
				// sockets all live under /ws/, so any other upgrade is a proxied page's (Vite HMR sends no Referer). ROMP
				// never frames itself either, so any frame navigation is a proxied page's: one whose client-side router
				// pushed a root-absolute URL carries no /proxy/ Referer, and would otherwise load ROMP inside its own pane.
				const foreignSocket = isUpgrade && !url.pathname.startsWith("/ws/");
				const framed = req.headers.get("sec-fetch-dest") === "iframe";
				const port = refererProxyPort(req) ?? (foreignSocket || framed ? cookieProxyPort(req) : null);
				if (port !== null && port !== deps.cfg.listen.port) {
					if (isUpgrade) {
						return await proxyWebSocket(req, url, prefixedTarget(port, url), loopbackHost(port, listeningSockets()), server);
					}
					const location = `/proxy/${port}${url.pathname}${url.search}`;
					return new Response(null, { status: 307, headers: { location, "cache-control": "no-store" } });
				}
			}
			if (url.pathname.startsWith("/ws/")) {
				if (!isUpgrade) throw badRequest("Expected a WebSocket upgrade");
				const data = socketData(url.pathname);
				return server.upgrade(req, { data }) ? undefined : toErrorResponse(badRequest("WebSocket upgrade failed"));
			}
			if (identity !== null && isApiPath(url.pathname)) {
				const match = router.match(req.method, url.pathname);
				if (!match) throw notFound(`No route for ${url.pathname}`);
				if ("allowed" in match) {
					return new Response(null, { status: 405, headers: { allow: match.allowed.join(", ") } });
				}
				return await match.handler({ req, url, identity }, match.params);
			}
			if (req.method !== "GET" && req.method !== "HEAD") {
				return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
			}
			return await serveStatic(deps.cfg.webDir, url.pathname, req.method);
		} catch (err) {
			return toErrorResponse(err);
		}
	}

	function socketData(pathname: string): WsData {
		const [, , kind, id = "", extra] = pathname.split("/");
		if (extra === undefined) {
			if (kind === "term") {
				const term = deps.terms.get(id);
				if (term) return { kind: "term", term };
				return { kind: "reject", code: 4404, reason: "unknown terminal" };
			}
			if (kind === "agent") {
				const agent = deps.agents.get(id);
				if (agent) return { kind: "agent", agent };
				return { kind: "reject", code: 4404, reason: "unknown agent" };
			}
		}
		return { kind: "reject", code: 4404, reason: "unknown socket" };
	}

	const websocket: WebSocketHandler<WsData> = {
		perMessageDeflate: true,
		maxPayloadLength: 16 * 1024 * 1024,
		open(ws) {
			const data = ws.data;
			if (data.kind === "term") data.term.attach(ws);
			else if (data.kind === "agent") data.agent.attach(ws);
			else if (data.kind === "proxy") proxySocket.open(ws, data);
			else ws.close(data.code, data.reason);
		},
		message(ws, message) {
			const data = ws.data;
			if (data.kind === "proxy") {
				proxySocket.message(data, message);
				return;
			}
			if (data.kind === "reject") return;
			const parsed = typeof message === "string" ? parseMessage(message) : null;
			if (data.kind === "term" && isTermMsg(parsed)) {
				if (parsed.t === "in") data.term.input(parsed.d);
				else data.term.resize(parsed.cols, parsed.rows);
			} else if (data.kind === "agent" && isAgentMsg(parsed)) {
				if (parsed.t === "rpc") void data.agent.rpc(ws, parsed.reqId, parsed.cmd);
				else data.agent.answerUi(parsed.response);
			} else {
				ws.close(1008, "invalid message");
			}
		},
		close(ws, code, reason) {
			const data = ws.data;
			if (data.kind === "term") data.term.detach(ws);
			else if (data.kind === "agent") data.agent.detach(ws);
			else if (data.kind === "proxy") proxySocket.close(data, code, reason);
		},
	};

	return { fetch, websocket };
}

function parseMessage(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

const isDimension = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1000;

function isTermMsg(msg: unknown): msg is TermClientMsg {
	if (!isRecord(msg)) return false;
	if (msg.t === "in") return typeof msg.d === "string";
	return msg.t === "resize" && isDimension(msg.cols) && isDimension(msg.rows);
}

function isAgentMsg(msg: unknown): msg is AgentClientMsg {
	if (!isRecord(msg)) return false;
	if (msg.t === "rpc") return typeof msg.reqId === "string" && isRecord(msg.cmd) && typeof msg.cmd.type === "string";
	return msg.t === "ui" && isRecord(msg.response) && msg.response.type === "extension_ui_response";
}

async function requireDir(roots: Roots, input: unknown): Promise<string> {
	const path = await roots.resolve(roots.logical(input));
	if (!(await stat(path)).isDirectory()) throw badRequest(`${path} is not a directory`);
	return path;
}

function optionalStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item !== "")) {
		throw badRequest(`"${key}" must be a non-empty array of non-empty strings`);
	}
	return value;
}

function requireChoice(value: unknown): ModelChoice {
	const choice = parseChoice(value);
	if (!choice) throw badRequest(`expected { model: { provider, id } | null, level: ${THINKING_LEVELS.join(" | ")} | null }`);
	return choice;
}

function buildRouter(deps: AppDeps): Router<Ctx> {
	const { cfg, roots, files, terms, agents, romp } = deps;
	const router = new Router<Ctx>();
	const query = (ctx: Ctx, key: string) => ctx.url.searchParams.get(key);
	const setups = new TaskSetups(terms, romp, cfg.shell);

	router.on("GET", "/api/me", ({ identity }) =>
		json({
			login: identity.login,
			displayName: identity.displayName,
			avatarUrl: identity.avatarUrl,
			user: deps.user,
			host: deps.host,
			home: deps.home,
			roots: [...roots.dirs],
		} satisfies Me),
	);

	// ── Account ──
	router.on("GET", "/api/git-identity", async () => json(await readGitIdentity(romp)));
	router.on("PUT", "/api/git-identity", async ({ req }) => {
		const body = await readJson(req, SMALL_BODY);
		const update: Partial<GitIdentity> = {};
		for (const key of ["name", "email"] as const) {
			const value = body[key];
			if (value === undefined) continue;
			if (typeof value !== "string" || !value.trim()) throw badRequest(`"${key}" must be a non-empty string`);
			if (/[\r\n]/.test(value)) throw badRequest(`"${key}" must be a single line`);
			update[key] = value.trim();
		}
		return json(await writeGitIdentity(romp, update));
	});

	// ── Push notifications ──
	router.on("GET", "/api/push", () => json({ publicKey: deps.push.publicKey } satisfies PushConfig));
	router.on("PUT", "/api/push/subscription", async ({ req }) => {
		const subscription = parseSubscription(await readJson(req, SMALL_BODY));
		// Apple refuses VAPID tokens whose subject is not a real site, so name the one the device subscribed from.
		deps.push.subscribe(subscription, `https://${req.headers.get("host") ?? deps.host}`);
		return noContent();
	});
	router.on("DELETE", "/api/push/subscription", async ({ req }) => {
		deps.push.unsubscribe(parseEndpoint(await readJson(req, SMALL_BODY)));
		return noContent();
	});
	router.on("PUT", "/api/push/presence", async ({ req }) => {
		const body = await readJson(req, SMALL_BODY);
		if (typeof body.active !== "boolean") throw badRequest(`"active" must be true or false`);
		deps.push.setPresence(parseEndpoint(body), body.active);
		return noContent();
	});
	router.on("POST", "/api/push/test", async ({ req }) => {
		await deps.push.test(parseEndpoint(await readJson(req, SMALL_BODY)));
		return noContent();
	});

	// ── Cloudflare builds ──
	router.on("GET", "/api/cloudflare", () => json(deps.cloudflare.status()));
	router.on("PUT", "/api/cloudflare", async ({ req }) =>
		json(await deps.cloudflare.connect(requireString(await readJson(req, SMALL_BODY), "token"))),
	);
	router.on("DELETE", "/api/cloudflare", async () => json(await deps.cloudflare.disconnect()));
	router.on("GET", "/api/cloudflare/workers", async () => json(await deps.cloudflare.workers()));
	router.on("PUT", "/api/cloudflare/workers/:name", async ({ req }, { name = "" }) => {
		const body = await readJson(req, SMALL_BODY);
		if (typeof body.subscribed !== "boolean") throw badRequest(`"subscribed" must be true or false`);
		await deps.cloudflare.setWorker(name, body.subscribed);
		return noContent();
	});

	// ── ROMP updates ──
	router.on("GET", "/api/update", async () => json(await deps.updates.status()));
	router.on("POST", "/api/update", async () => json(await deps.updates.request()));

	// ── Terminals ──
	router.on("GET", "/api/terms", () => json(terms.list()));
	router.on("POST", "/api/terms", async ({ req }) => {
		const body = await readJson(req, SMALL_BODY);
		const cols = requireInt(body, "cols", 1, 1000);
		const rows = requireInt(body, "rows", 1, 1000);
		const cwd = await requireDir(roots, optionalString(body, "cwd") || (roots.contains(deps.home) ? deps.home : roots.dirs[0]));
		const command = optionalStringArray(body, "command");
		const argv = command ?? [cfg.shell, "-l"];
		const title = optionalString(body, "title")?.trim() || basename(argv[0] ?? "shell");
		return json(terms.create({ argv, cwd, cols, rows, title }).info(), 201);
	});
	router.on("DELETE", "/api/terms/:id", (_ctx, { id = "" }) => {
		if (!terms.remove(id)) throw notFound("Unknown terminal");
		return noContent();
	});

	// ── Files ──
	router.on("GET", "/api/fs/list", async (ctx) => json(await files.list(query(ctx, "path"))));
	router.on("GET", "/api/fs/read", async (ctx) => json(await files.read(query(ctx, "path"))));
	router.on("PUT", "/api/fs/write", async ({ req }) => {
		const body = await readJson(req, WRITE_BODY);
		if (typeof body.content !== "string") throw badRequest(`"content" must be a string`);
		const expected = body.expectedMtimeMs;
		if (expected !== undefined && (typeof expected !== "number" || !Number.isFinite(expected))) {
			throw badRequest(`"expectedMtimeMs" must be a number`);
		}
		return json(await files.write(body.path, body.content, expected));
	});
	router.on("POST", "/api/fs/op", async ({ req }) => json(await files.op(parseFsOp(await readJson(req, SMALL_BODY)))));
	router.on("GET", "/api/fs/raw", async (ctx) => {
		const path = await files.rawPath(query(ctx, "path"));
		const file = Bun.file(path);
		const headers: Record<string, string> = {
			"content-type": file.type,
			"cache-control": "no-store",
			// User files must never run as scripts in the gateway's origin.
			"content-security-policy": "sandbox",
			"x-content-type-options": "nosniff",
		};
		if (query(ctx, "download") !== null) {
			headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`;
		}
		return new Response(file, { headers });
	});
	router.on("PUT", "/api/fs/upload", async (ctx) => {
		requireOctetStream(ctx.req);
		const name = query(ctx, "name");
		if (name === null) throw badRequest(`"name" is required`);
		const length = ctx.req.headers.get("content-length");
		const declared = length === null || !/^\d+$/.test(length) ? null : Number(length);
		return json(await files.upload(query(ctx, "path"), name, query(ctx, "overwrite") === "1", ctx.req.body, declared));
	});

	// ── Agents ──
	router.on("GET", "/api/agents", () => json(agents.list()));
	router.on("POST", "/api/agents", async ({ req }) => {
		const body = await readJson(req, SMALL_BODY);
		const cwd = await requireDir(roots, requireString(body, "cwd"));
		return json(agents.create(cwd, optionalString(body, "title"), optionalString(body, "prompt") || undefined).info(), 201);
	});
	router.on("GET", "/api/agents/:id", (_ctx, { id = "" }) => {
		const agent = agents.get(id);
		if (!agent) throw notFound("Unknown agent");
		return json(agent.info());
	});
	router.on("GET", "/api/agents/:id/usage", async (_ctx, { id = "" }) => {
		const usage = await agents.usage(id);
		if (!usage) throw notFound("Unknown agent");
		return json(usage);
	});
	router.on("GET", "/api/agents/:id/thinking", async (_ctx, { id = "" }) => {
		const agent = agents.get(id);
		if (!agent) throw notFound("Unknown agent");
		return json(await agent.thinking());
	});
	router.on("PUT", "/api/agents/:id/thinking", async ({ req }, { id = "" }) => {
		const agent = agents.get(id);
		if (!agent) throw notFound("Unknown agent");
		const choice = requireChoice(await readJson(req, SMALL_BODY));
		await agents.checkChoice(choice);
		return json(await agent.setThinking(choice));
	});
	router.on("GET", "/api/models", async () => json(await agents.models()));
	router.on("DELETE", "/api/agents/:id", async (_ctx, { id = "" }) => {
		if (!(await agents.remove(id))) throw notFound("Unknown agent");
		return noContent();
	});

	// ── Ports ──
	router.on("GET", "/api/ports", () => {
		const uid = process.getuid?.() ?? -1;
		const byPort = new Map<number, number>();
		for (const socket of listeningSockets()) {
			if (socket.uid !== uid || socket.scope === "other" || socket.localPort === cfg.listen.port) continue;
			if (!byPort.has(socket.localPort)) byPort.set(socket.localPort, socket.inode);
		}
		const names = socketProcessNames(new Set(byPort.values()));
		const ports: ListeningPort[] = [...byPort]
			.sort(([a], [b]) => a - b)
			.map(([port, inode]) => ({ port, process: names.get(inode) ?? null }));
		return json(ports);
	});

	// ── Dev servers ──
	router.on("GET", "/api/dev", () => json(deps.dev.list()));
	router.on("GET", "/api/dev/command", async (ctx) => {
		const cwd = await requireDir(roots, query(ctx, "cwd"));
		return json({
			cwd,
			command: await resolveDevCommand(romp, cwd),
			repo: taskForPath(romp, cwd)?.repo ?? null,
		} satisfies DevCommand);
	});
	router.on("POST", "/api/dev", async ({ req }) => {
		const cwd = await requireDir(roots, requireString(await readJson(req, SMALL_BODY), "cwd"));
		return json(await deps.dev.start(cwd));
	});
	router.on("DELETE", "/api/dev/:id", async (_ctx, { id = "" }) => {
		if (!(await deps.dev.stop(id))) throw notFound("Unknown dev server");
		return noContent();
	});

	// ── Sign-in callback ──
	router.on("POST", "/api/callback", async ({ req }) => {
		const target = parseLoopbackCallback(requireString(await readJson(req, SMALL_BODY), "url"));
		if (!target) throw badRequest("That isn't a localhost address. Copy the full address your browser ended on.");
		const uid = process.getuid?.() ?? -1;
		return json(await deliverCallback(target, { ownPort: cfg.listen.port, uid, listeners: listeningSockets() }));
	});

	// ── Shell state ──
	router.on("GET", "/api/state", async () => json(await deps.shellState.get()));
	router.on("PUT", "/api/state", async ({ req }) => {
		await deps.shellState.put(await readJson(req, MAX_STATE_BYTES));
		return noContent();
	});

	// ── Repos & tasks ──
	router.on("GET", "/api/repos", async () => json(await listRepos(romp)));
	// A repo named "search" can still be deleted: only GET is taken here, and no GET /api/repos/:name exists.
	router.on("GET", "/api/repos/search", async (ctx) => json(await deps.repoSearch.search(query(ctx, "q") ?? "")));
	router.on("POST", "/api/repos", async ({ req }) => {
		const body = await readJson(req, SMALL_BODY);
		const add = {
			url: requireString(body, "url"),
			name: optionalString(body, "name") || undefined,
			branch: optionalString(body, "branch") || undefined,
		};
		return json(await addRepo(romp, add), 201);
	});
	router.on("DELETE", "/api/repos/:name", async (_ctx, { name = "" }) => {
		await removeRepo(romp, name);
		setups.discardRepo(name);
		await agents.removeForRepo(name);
		return noContent();
	});
	router.on("GET", "/api/repos/:name/branches", async (_ctx, { name = "" }) => json(await repoBranches(romp, name)));
	router.on("PUT", "/api/repos/:name/settings", async ({ req }, { name = "" }) => {
		const body = await readJson(req, SMALL_BODY);
		const update: Parameters<typeof updateRepoSettings>[2] = {};
		if (body.land !== undefined) {
			if (body.land !== "push" && body.land !== "pr") throw badRequest(`"land" must be "push" or "pr"`);
			update.land = body.land;
		}
		for (const key of ["setup", "test", "dev"] as const) {
			const value = body[key];
			if (value === undefined) continue;
			if (value !== null && typeof value !== "string") throw badRequest(`"${key}" must be a string or null`);
			update[key] = value;
		}
		if (body.branch !== undefined) update.branch = requireString(body, "branch");
		if (body.color !== undefined) {
			if (!isRepoColor(body.color)) throw badRequest(`"color" must be one of ${REPO_COLORS.join(", ")}`);
			update.color = body.color;
		}
		return json(await updateRepoSettings(romp, name, update));
	});
	router.on("PUT", "/api/repos/:name/env", async ({ req }, { name = "" }) =>
		json(await setRepoEnv(romp, name, await readBytes(req, MAX_ENV_BYTES))),
	);
	router.on("DELETE", "/api/repos/:name/env", async (_ctx, { name = "" }) => json(await clearRepoEnv(romp, name)));
	router.on("GET", "/api/tasks", async () => json((await listTasks(romp)).map((t) => setups.view(t))));
	router.on("POST", "/api/tasks", async ({ req }) => {
		const body = await readJson(req, SMALL_BODY);
		const prompt = optionalString(body, "prompt")?.trim();
		if (body.autoTitle !== undefined && typeof body.autoTitle !== "boolean") throw badRequest(`"autoTitle" must be true or false`);
		const choice = body.thinking === undefined ? undefined : requireChoice(body.thinking);
		if (choice) await agents.checkChoice(choice);
		const task = await createTask(romp, {
			repo: requireString(body, "repo"),
			title: requireString(body, "title"),
			slug: optionalString(body, "slug") || undefined,
		});
		const cwd = await requireDir(roots, task.path);
		// Setup and the agent both start now; the agent doesn't wait for dependencies to install.
		task.setup = setups.start(task, cwd);
		const agent = prompt ? agents.create(cwd, task.title, prompt, choice).info() : null;
		if (body.autoTitle && prompt && agent) {
			retitle(task, agent.id, prompt).catch((err: unknown) =>
				console.warn(`titling ${task.repo}/${task.slug}: ${errorMessage(err)}`),
			);
		}
		return json({ task, agent } satisfies TaskCreated, 201);
	});
	router.on("POST", "/api/tasks/:repo/:slug/ship", async ({ req }, { repo = "", slug = "" }) => {
		const body = await readJson(req, SMALL_BODY);
		const task = await shipTask(romp, repo, slug, { message: optionalString(body, "message") || undefined });
		return json(setups.view(task));
	});
	router.on("POST", "/api/tasks/:repo/:slug/setup", async (_ctx, { repo = "", slug = "" }) => {
		const task = await getTask(romp, repo, slug);
		const setup = setups.retry(task, await requireDir(roots, task.path));
		return json(setups.view({ ...task, setup }));
	});
	router.on("DELETE", "/api/tasks/:repo/:slug", async (_ctx, { repo = "", slug = "" }) => {
		// Stop a setup still writing into the worktree before it is removed.
		setups.discard(repo, slug);
		await removeTask(romp, repo, slug);
		await agents.removeForTask(repo, slug);
		return noContent();
	});

	/** Names a new task (and its agent and OMP session) after a model-written title, keeping the slug. */
	async function retitle(task: TaskInfo, agentId: string, prompt: string): Promise<void> {
		const title = await deps.titles(task.path, prompt);
		if (!title) {
			console.warn(`titling ${task.repo}/${task.slug}: no title generated; keeping "${task.title}"`);
			return;
		}
		if (title === task.title) return;
		await renameTask(romp, task.repo, task.slug, title);
		await agents.rename(agentId, title);
	}

	return router;
}
