import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, locateConfig, parseListen, resolveConfig, type ResolveContext } from "../src/config.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "romp-config-")));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const ctx: ResolveContext = {
	home,
	baseDir: "/etc/romp",
	which: (cmd) => (cmd === "nope" ? null : `/usr/bin/${cmd}`),
	uidOf: (user) => (({ caddy: 997, root: 0, me: 1000 }) as Record<string, number>)[user] ?? null,
	selfUid: 1000,
};

describe("resolveConfig", () => {
	test("applies defaults", () => {
		const cfg = resolveConfig({ allow_logins: ["Me@Example.com"] }, ctx);
		expect(cfg.listen).toEqual({ hostname: "127.0.0.1", port: 7680 });
		expect(cfg.allowLogins).toEqual(["me@example.com"]);
		expect(cfg.dev).toBe(false);
		expect(cfg.roots).toEqual([home]);
		expect(cfg.stateDir).toBe(join(home, ".local/state/romp"));
		expect(cfg.ompFound).toBe(true);
	});
	test("resolves relative paths against the config directory and ~ against home", () => {
		const cfg = resolveConfig({ dev: true, web_dir: "web", state_dir: "~/state" }, ctx);
		expect(cfg.webDir).toBe("/etc/romp/web");
		expect(cfg.stateDir).toBe(join(home, "state"));
	});
	test("rejects unknown keys and wrong types", () => {
		expect(() => resolveConfig({ dev: true, prot: 1 }, ctx)).toThrow(ConfigError);
		expect(() => resolveConfig({ dev: "yes" }, ctx)).toThrow(ConfigError);
		expect(() => resolveConfig({ dev: true, roots: "~" }, ctx)).toThrow(ConfigError);
	});
	test("requires an allowlist unless dev", () => {
		expect(() => resolveConfig({}, ctx)).toThrow("allow_logins");
		expect(resolveConfig({ dev: true }, ctx).allowLogins).toEqual([]);
	});
	test("only loopback listen addresses are accepted, in dev and otherwise", () => {
		expect(() => resolveConfig({ dev: true, listen: "0.0.0.0:7680" }, ctx)).toThrow("loopback");
		expect(() => resolveConfig({ allow_logins: ["a"], listen: "100.64.0.1:7680" }, ctx)).toThrow("loopback");
		expect(resolveConfig({ dev: true, listen: "[::1]:9000" }, ctx).listen).toEqual({ hostname: "::1", port: 9000 });
	});
	test("roots must exist and be absolute", () => {
		expect(() => resolveConfig({ dev: true, roots: [join(home, "missing")] }, ctx)).toThrow("does not exist");
		expect(() => resolveConfig({ dev: true, roots: ["relative"] }, ctx)).toThrow("absolute");
		expect(() => resolveConfig({ dev: true, roots: [] }, ctx)).toThrow("at least one");
	});
	test("lan_proxy_user must be a dedicated existing account", () => {
		expect(resolveConfig({ dev: true }, ctx).lanProxyUid).toBeNull();
		expect(resolveConfig({ dev: true, lan_proxy_user: "caddy" }, ctx).lanProxyUid).toBe(997);
		expect(() => resolveConfig({ dev: true, lan_proxy_user: "ghost" }, ctx)).toThrow("not a Linux account");
		expect(() => resolveConfig({ dev: true, lan_proxy_user: "root" }, ctx)).toThrow("dedicated");
		expect(() => resolveConfig({ dev: true, lan_proxy_user: "me" }, ctx)).toThrow("dedicated");
	});
	test("a missing shell is an error, a missing omp is not", () => {
		expect(() => resolveConfig({ dev: true, shell: "nope" }, ctx)).toThrow("shell");
		const cfg = resolveConfig({ dev: true, omp: "nope" }, ctx);
		expect(cfg.ompFound).toBe(false);
		expect(cfg.omp).toBe("nope");
	});
});

test("parseListen rejects malformed addresses", () => {
	for (const bad of ["7680", "127.0.0.1", "127.0.0.1:0", "127.0.0.1:70000", "::1:7680"]) {
		expect(() => parseListen(bad)).toThrow(ConfigError);
	}
});

describe("locateConfig", () => {
	test("--config wins over the environment, which wins over the default", () => {
		expect(locateConfig(["--config", "/x.toml"], { ROMP_GATEWAY_CONFIG: "/y.toml" }, home)).toEqual({
			path: "/x.toml",
			explicit: true,
		});
		expect(locateConfig(["--config=~/x.toml"], {}, home).path).toBe(join(home, "x.toml"));
		expect(locateConfig([], { ROMP_GATEWAY_CONFIG: "/y.toml" }, home)).toEqual({ path: "/y.toml", explicit: true });
		expect(locateConfig([], {}, home)).toEqual({ path: join(home, ".config/romp/gateway.toml"), explicit: false });
	});
	test("rejects unknown arguments and a missing value", () => {
		expect(() => locateConfig(["--port", "1"], {}, home)).toThrow(ConfigError);
		expect(() => locateConfig(["--config"], {}, home)).toThrow(ConfigError);
	});
});
