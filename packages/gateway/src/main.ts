#!/usr/bin/env bun
import { rompEnv, taskForPath } from "@romp/core";
import { MAX_UPLOAD_BYTES } from "@romp/protocol";
import { realpathSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { AgentManager } from "./agents/manager.ts";
import { ompTitleGenerator } from "./agents/title.ts";
import { createApp } from "./app.ts";
import { Auth } from "./auth.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { Files } from "./files.ts";
import { RepoSearch } from "./github.ts";
import { passwd } from "./passwd.ts";
import { Roots } from "./paths.ts";
import { PushService } from "./push.ts";
import { LanSessions } from "./sessions.ts";
import { ShellStateStore } from "./shellstate.ts";
import { TerminalManager } from "./terminals.ts";
import { errorMessage } from "./util.ts";
import type { WsData } from "./ws.ts";

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv[0] === "passwd") process.exit(await passwd(argv.slice(1)));
	let cfg;
	try {
		cfg = loadConfig(argv, process.env);
	} catch (err) {
		if (!(err instanceof ConfigError)) throw err;
		console.error(`romp-gateway: ${err.message}`);
		process.exit(2);
	}
	const home = realpathSync(homedir());
	const roots = new Roots(cfg.roots, home);
	const romp = rompEnv();
	const push = new PushService(cfg.stateDir);
	await push.load();
	const agents = new AgentManager({
		omp: cfg.omp,
		ompFound: cfg.ompFound,
		stateDir: cfg.stateDir,
		busyFile: process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "romp-gateway.busy") : null,
		taskOf: (cwd) => taskForPath(romp, cwd),
		notify: (agent, notice) =>
			push.notify({ title: agent.title, body: notice.text, tag: `agent-${agent.id}`, agentId: agent.id, cwd: agent.cwd }),
	});
	await agents.load();
	const sessions = new LanSessions(cfg.passwordFile, cfg.stateDir);
	await sessions.load();
	const terms = new TerminalManager();
	const app = createApp({
		cfg,
		roots,
		home,
		user: userInfo().username,
		host: hostname(),
		auth: new Auth(cfg, sessions),
		files: new Files(roots, home),
		terms,
		agents,
		shellState: new ShellStateStore(cfg.stateDir),
		sessions,
		push,
		romp,
		titles: ompTitleGenerator(cfg.omp),
		repoSearch: new RepoSearch(),
	});

	const server = Bun.serve<WsData>({
		hostname: cfg.listen.hostname,
		port: cfg.listen.port,
		// Proxied dev servers may hold a request open (SSE, long polling); 255 s is Bun's maximum.
		idleTimeout: 255,
		// Room for `/api/fs/upload`, which streams to disk and enforces its own limit; JSON routes keep theirs.
		maxRequestBodySize: MAX_UPLOAD_BYTES + 1024 * 1024,
		fetch: app.fetch,
		websocket: app.websocket,
	});
	if (!cfg.ompFound) console.warn(`romp-gateway: "${cfg.omp}" not found on PATH; agents are unavailable`);
	console.log(
		`romp-gateway listening on http://${cfg.listen.hostname}:${server.port}${cfg.dev ? " (dev: authentication disabled)" : ""}`,
	);

	let stopping = false;
	const shutdown = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		console.log(`romp-gateway: ${signal}, shutting down`);
		void server.stop();
		terms.shutdown();
		await agents.shutdown();
		await sessions.flush();
		await push.flush();
		await server.stop(true);
		process.exit(0);
	};
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
	console.error(`romp-gateway: ${errorMessage(err)}`);
	process.exit(1);
});
