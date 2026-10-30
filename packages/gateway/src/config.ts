import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage, expandHome, isRecord } from "./util.ts";

export interface ListenAddress {
	hostname: string;
	port: number;
}

export interface GatewayConfig {
	listen: ListenAddress;
	/** Lowercased Tailscale logins allowed to use this gateway. */
	allowLogins: string[];
	/** Disables authentication. Only accepted on a loopback listen address. */
	dev: boolean;
	/** Realpaths of the directories the files API, terminals and agents may use. */
	roots: string[];
	shell: string;
	omp: string;
	/** False when `omp` could not be found on PATH at startup. */
	ompFound: boolean;
	webDir: string;
	stateDir: string;
}

export class ConfigError extends Error {}

const KEYS: Record<string, true> = {
	listen: true,
	allow_logins: true,
	dev: true,
	roots: true,
	shell: true,
	omp: true,
	web_dir: true,
	state_dir: true,
};
const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));
const USAGE = "usage: romp-gateway [--config <path>]";

export function parseListen(value: string): ListenAddress {
	const match = /^(?:\[([0-9a-fA-F:.]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(value);
	const port = Number(match?.[3]);
	if (!match || port < 1 || port > 65535) {
		throw new ConfigError(`"listen" must look like "127.0.0.1:7680" or "[::1]:7680", got ${JSON.stringify(value)}`);
	}
	return { hostname: match[1] ?? match[2] ?? "", port };
}

export function isLoopbackHost(hostname: string): boolean {
	if (hostname === "localhost" || hostname === "::1") return true;
	const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
	return octets !== null && octets.slice(1).every((octet) => Number(octet) <= 255);
}

export interface ResolveContext {
	home: string;
	/** Directory relative `web_dir`/`state_dir` values resolve against (the config file's directory). */
	baseDir: string;
	which(command: string): string | null;
}

/** Validates a parsed TOML document and fills in defaults. */
export function resolveConfig(raw: Record<string, unknown>, ctx: ResolveContext): GatewayConfig {
	for (const key of Object.keys(raw)) {
		if (!Object.hasOwn(KEYS, key)) throw new ConfigError(`unknown key "${key}"`);
	}
	const listen = parseListen(optString(raw, "listen") ?? "127.0.0.1:7680");
	const dev = optBoolean(raw, "dev") ?? false;
	if (!isLoopbackHost(listen.hostname)) {
		throw new ConfigError(
			dev
				? `"dev = true" disables authentication and is only allowed on a loopback listen address, got "${listen.hostname}"`
				: `"listen" must be a loopback address (Tailscale identity headers are only trustworthy behind \`tailscale serve\`), got "${listen.hostname}"`,
		);
	}
	const allowLogins = (optStringArray(raw, "allow_logins") ?? []).map((login) => login.toLowerCase());
	if (!dev && allowLogins.length === 0) {
		throw new ConfigError(`"allow_logins" must list at least one Tailscale login (or set "dev = true" for local development)`);
	}
	const roots = resolveRoots(optStringArray(raw, "roots") ?? ["~"], ctx.home);

	const shellName = optString(raw, "shell") ?? "/bin/bash";
	const shell = ctx.which(shellName);
	if (!shell) throw new ConfigError(`"shell" ${JSON.stringify(shellName)} is not an executable`);
	const ompName = optString(raw, "omp") ?? "omp";
	const omp = ctx.which(ompName);

	const path = (key: string, fallback: string) => {
		const value = optString(raw, key);
		return value === undefined ? fallback : resolve(ctx.baseDir, expandHome(value, ctx.home));
	};
	return {
		listen,
		allowLogins,
		dev,
		roots,
		shell,
		omp: omp ?? ompName,
		ompFound: omp !== null,
		webDir: path("web_dir", DEFAULT_WEB_DIR),
		stateDir: path("state_dir", join(ctx.home, ".local/state/romp")),
	};
}

function resolveRoots(values: string[], home: string): string[] {
	if (values.length === 0) throw new ConfigError(`"roots" must list at least one directory`);
	const roots: string[] = [];
	for (const value of values) {
		const expanded = expandHome(value, home);
		if (!isAbsolute(expanded)) throw new ConfigError(`root ${JSON.stringify(value)} must be absolute or start with ~`);
		let real: string;
		try {
			real = realpathSync(expanded);
		} catch {
			throw new ConfigError(`root ${JSON.stringify(value)} does not exist`);
		}
		if (!statSync(real).isDirectory()) throw new ConfigError(`root ${JSON.stringify(value)} is not a directory`);
		if (!roots.includes(real)) roots.push(real);
	}
	return roots;
}

function optString(raw: Record<string, unknown>, key: string): string | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value === "") throw new ConfigError(`"${key}" must be a non-empty string`);
	return value;
}

function optBoolean(raw: Record<string, unknown>, key: string): boolean | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new ConfigError(`"${key}" must be true or false`);
	return value;
}

function optStringArray(raw: Record<string, unknown>, key: string): string[] | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item !== "")) {
		throw new ConfigError(`"${key}" must be an array of non-empty strings`);
	}
	return value;
}

export interface ConfigLocation {
	path: string;
	/** Given via `--config` or `$ROMP_GATEWAY_CONFIG`, so it must exist. */
	explicit: boolean;
}

export function locateConfig(argv: readonly string[], env: Record<string, string | undefined>, home: string): ConfigLocation {
	let flag: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--config") {
			flag = argv[++i];
			if (!flag) throw new ConfigError(`--config needs a path (${USAGE})`);
		} else if (arg.startsWith("--config=")) {
			flag = arg.slice("--config=".length);
		} else {
			throw new ConfigError(`unknown argument ${JSON.stringify(arg)} (${USAGE})`);
		}
	}
	const explicit = flag ?? env.ROMP_GATEWAY_CONFIG;
	if (explicit) return { path: resolve(expandHome(explicit, home)), explicit: true };
	return { path: join(home, ".config/romp/gateway.toml"), explicit: false };
}

export function loadConfig(argv: readonly string[], env: Record<string, string | undefined>): GatewayConfig {
	const home = homedir();
	const { path, explicit } = locateConfig(argv, env, home);
	let raw: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed: unknown = Bun.TOML.parse(readFileSync(path, "utf8"));
			if (isRecord(parsed)) raw = parsed;
		} catch (err) {
			throw new ConfigError(`${path}: ${errorMessage(err)}`);
		}
	} else if (explicit) {
		throw new ConfigError(`config file ${path} does not exist`);
	}
	try {
		return resolveConfig(raw, { home, baseDir: dirname(path), which: (command) => Bun.which(command) });
	} catch (err) {
		if (err instanceof ConfigError) throw new ConfigError(`${path}: ${err.message}`);
		throw err;
	}
}
