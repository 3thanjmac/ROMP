import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/http.ts";
import { parseProxyPath, rewriteLocation, sendableCloseCode } from "../src/proxy.ts";

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

test("sendableCloseCode maps reserved codes", () => {
	expect(sendableCloseCode(1000)).toBe(1000);
	expect(sendableCloseCode(4001)).toBe(4001);
	expect(sendableCloseCode(1005)).toBe(1000);
	expect(sendableCloseCode(1006)).toBe(1011);
	expect(sendableCloseCode(1015)).toBe(1011);
});
