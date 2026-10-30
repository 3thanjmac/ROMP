#!/usr/bin/env bun
import { rompEnv, taskForPath } from "@romp/core";
import { realpathSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { AgentManager } from "./agents/manager.ts";
import { createApp } from "./app.ts";
import { Auth } from "./auth.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { Files } from "./files.ts";
import { Roots } from "./paths.ts";
import { ShellStateStore } from "./shellstate.ts";
import { TerminalManager } from "./terminals.ts";
import { errorMessage } from "./util.ts";
import type { WsData } from "./ws.ts";

async function main(): Promise<void> {
	let cfg;
	try {
		cfg = loadConfig(process.argv.slice(2), process.env);
	} catch (err) {
		if (!(err instanceof ConfigError)) throw err;
		console.error(`romp-gateway: ${err.message}`);
		process.exit(2);
	}
	const home = realpathSync(homedir());
	const roots = new Roots(cfg.roots, home);
	const romp = rompEnv();
	const agents = new AgentManager({
		omp: cfg.omp,
		ompFound: cfg.ompFound,
		stateDir: cfg.stateDir,
		taskOf: (cwd) => taskForPath(romp, cwd),
	});
	await agents.load();
	const terms = new TerminalManager();
	const app = createApp({
		cfg,
		roots,
		home,
		user: userInfo().username,
		host: hostname(),
		auth: new Auth(cfg),
		files: new Files(roots, home),
		terms,
		agents,
		shellState: new ShellStateStore(cfg.stateDir),
		romp,
	});

	const server = Bun.serve<WsData>({
		hostname: cfg.listen.hostname,
		port: cfg.listen.port,
		// Proxied dev servers may hold a request open (SSE, long polling); 255 s is Bun's maximum.
		idleTimeout: 255,
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
