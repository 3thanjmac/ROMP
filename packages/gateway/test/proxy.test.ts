import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/http.ts";
import { TCP_LISTEN, type TcpSocket } from "../src/procnet.ts";
import {
	cookieProxyPort,
	loopbackHost,
	parseProxyPath,
	refererProxyPort,
	rewriteLocation,
	sendableCloseCode,
} from "../src/proxy.ts";

describe("parseProxyPath", () => {
	test("/proxy strips the prefix and keeps the query", () => {
		expect(parseProxyPath("/proxy/5173/src/main.ts", "?v=1")).toEqual({
			target: { port: 5173, prefix: "/proxy/5173", upstreamPath: "/src/main.ts?v=1" },
		});
		expect(parseProxyPath("/proxy/5173/", "")).toEqual({
			target: { port: 5173, prefix: "/proxy/5173", upstreamPath: "/" },
		});
	});
	test("/proxy without a trailing slash redirects", () => {
		expect(parseProxyPath("/proxy/8080", "?a=b")).toEqual({ redirect: "/proxy/8080/?a=b" });
	});
	test("/absproxy keeps the full path", () => {
		expect(parseProxyPath("/absproxy/5173/assets/x.js", "")).toEqual({
			target: { port: 5173, prefix: "/absproxy/5173", upstreamPath: "/absproxy/5173/assets/x.js" },
		});
		expect(parseProxyPath("/absproxy/5173", "")).toEqual({
			target: { port: 5173, prefix: "/absproxy/5173", upstreamPath: "/absproxy/5173" },
		});
	});
	test("other paths are not proxied", () => {
		expect(parseProxyPath("/api/me", "")).toBeNull();
		expect(parseProxyPath("/proxyx/1/", "")).toBeNull();
	});
	test("invalid ports are rejected", () => {
		for (const port of ["0", "65536", "080", "abc", "1e3"]) {
			expect(() => parseProxyPath(`/proxy/${port}/`, "")).toThrow(HttpError);
		}
	});
});

describe("rewriteLocation", () => {
	const strip = { port: 3000, prefix: "/proxy/3000", upstreamPath: "/" };
	const abs = { port: 3000, prefix: "/absproxy/3000", upstreamPath: "/absproxy/3000/" };
	test("prefixes root-relative and loopback redirects in strip mode", () => {
		expect(rewriteLocation("/login?next=1", strip)).toBe("/proxy/3000/login?next=1");
		expect(rewriteLocation("http://localhost:3000/a#b", strip)).toBe("/proxy/3000/a#b");
	});
	test("leaves foreign and relative redirects alone", () => {
		expect(rewriteLocation("https://example.com/", strip)).toBe("https://example.com/");
		expect(rewriteLocation("http://127.0.0.1:4000/", strip)).toBe("http://127.0.0.1:4000/");
		expect(rewriteLocation("next", strip)).toBe("next");
	});
	test("absproxy redirects already carry the base path", () => {
		expect(rewriteLocation("/absproxy/3000/x", abs)).toBe("/absproxy/3000/x");
		expect(rewriteLocation("http://127.0.0.1:3000/absproxy/3000/x", abs)).toBe("/absproxy/3000/x");
	});
});

describe("loopbackHost", () => {
	const listener = (family: 4 | 6, address: string, scope: TcpSocket["scope"], localPort = 5173): TcpSocket => ({
		family,
		address,
		scope,
		localPort,
		remotePort: 0,
		state: TCP_LISTEN,
		uid: 1000,
		inode: 1,
	});
	test("dials ::1 when the server listens only there (Vite bound to localhost on Debian)", () => {
		expect(loopbackHost(5173, [listener(6, "::1", "loopback")])).toBe("[::1]");
	});
	test("prefers 127.0.0.1 for IPv4 and wildcard listeners", () => {
		expect(loopbackHost(5173, [listener(6, "::1", "loopback"), listener(4, "127.0.0.1", "loopback")])).toBe("127.0.0.1");
		expect(loopbackHost(5173, [listener(4, "0.0.0.0", "any")])).toBe("127.0.0.1");
		expect(loopbackHost(5173, [listener(6, "::", "any")])).toBe("127.0.0.1");
	});
	test("ignores other ports and non-loopback addresses", () => {
		expect(loopbackHost(5173, [listener(6, "::1", "loopback", 8080)])).toBe("127.0.0.1");
		expect(loopbackHost(5173, [listener(6, "fd7a::1", "other")])).toBe("127.0.0.1");
		expect(loopbackHost(5173, [])).toBe("127.0.0.1");
	});
});

describe("root-absolute requests from proxied pages", () => {
	const req = (headers: Record<string, string>) =>
		new Request("http://romp.test/@vite/client", { headers: { host: "romp.test", ...headers } });
	test("a same-origin Referer under /proxy/<port>/ names the port", () => {
		expect(refererProxyPort(req({ referer: "https://romp.test/proxy/5173/privacy-policy/" }))).toBe(5173);
		expect(refererProxyPort(req({ referer: "https://romp.test/proxy/5173/" }))).toBe(5173);
	});
	test("ROMP's own pages, other origins and bad ports are not attributed", () => {
		expect(refererProxyPort(req({ referer: "https://romp.test/" }))).toBeNull();
		expect(refererProxyPort(req({ referer: "https://romp.test/proxy/5173" }))).toBeNull();
		expect(refererProxyPort(req({ referer: "https://evil.test/proxy/5173/" }))).toBeNull();
		expect(refererProxyPort(req({ referer: "https://romp.test/proxy/99999/" }))).toBeNull();
		expect(refererProxyPort(req({ referer: "https://romp.test/absproxy/5173/x" }))).toBeNull();
		expect(refererProxyPort(req({}))).toBeNull();
	});
	test("the port cookie is read among others", () => {
		expect(cookieProxyPort(req({ cookie: "a=1; romp-proxy-port=4321; b=2" }))).toBe(4321);
		expect(cookieProxyPort(req({ cookie: "romp-proxy-port=0" }))).toBeNull();
		expect(cookieProxyPort(req({ cookie: "other=5173" }))).toBeNull();
	});
});

test("sendableCloseCode maps reserved codes", () => {
	expect(sendableCloseCode(1000)).toBe(1000);
	expect(sendableCloseCode(4001)).toBe(4001);
	expect(sendableCloseCode(1005)).toBe(1000);
	expect(sendableCloseCode(1006)).toBe(1011);
	expect(sendableCloseCode(1015)).toBe(1011);
});
