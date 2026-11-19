import { parseLoopbackCallback } from "@romp/protocol";
import { afterAll, describe, expect, test } from "bun:test";
import { deliverCallback, pageText } from "../src/callback.ts";
import { HttpError } from "../src/http.ts";
import { TCP_LISTEN, type TcpSocket } from "../src/procnet.ts";

const UID = 1000;
const GATEWAY_PORT = 8080;

function listener(port: number, overrides: Partial<TcpSocket> = {}): TcpSocket {
	return {
		family: 6,
		address: "::1",
		scope: "loopback",
		localPort: port,
		remotePort: 0,
		state: TCP_LISTEN,
		uid: UID,
		inode: 1,
		...overrides,
	};
}

function target(text: string) {
	const parsed = parseLoopbackCallback(text);
	if (!parsed) throw new Error(`not a loopback URL: ${text}`);
	return parsed;
}

async function refusal(promise: Promise<unknown>): Promise<HttpError> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof HttpError) return err;
		throw err;
	}
	throw new Error("expected the callback to be refused");
}

describe("parseLoopbackCallback", () => {
	test("accepts http loopback addresses with a port", () => {
		expect(target("http://localhost:8976/oauth/callback?code=abc&state=x").port).toBe(8976);
		expect(target("  http://127.0.0.1:1455/auth/callback?code=1 ").port).toBe(1455);
		expect(target("http://[::1]:3000/").port).toBe(3000);
	});
	test("accepts an address copied without http://", () => {
		const parsed = target("localhost:8976/oauth/callback?code=abc&state=x");
		expect(parsed.url.href).toBe("http://localhost:8976/oauth/callback?code=abc&state=x");
		expect(target(" 127.0.0.1:1455/cb ").port).toBe(1455);
	});
	test("refuses other schemes, hosts, credentials and missing ports", () => {
		for (const text of [
			"https://localhost:8976/cb",
			"file:///etc/passwd",
			"http://example.com:8976/cb",
			"http://localhost.example.com:8976/cb",
			"http://127.0.0.2:8976/cb",
			"http://user:pw@localhost:8976/cb",
			"http://localhost/cb",
			"http://localhost:80/cb",
			"localhost/cb",
			"example.com:8976/cb",
			"ftp://localhost:8976/cb",
			"",
		]) {
			expect(parseLoopbackCallback(text)).toBeNull();
		}
	});
});

describe("pageText", () => {
	test("keeps the visible text of a page", () => {
		const html =
			"<html><head><title>x</title><style>p{}</style></head><body><h1>Signed in</h1><script>go()</script>" +
			"<p>You can close&nbsp;this tab &amp; return to the terminal.</p></body></html>";
		expect(pageText(html)).toBe("Signed in You can close this tab & return to the terminal.");
	});
	test("caps the excerpt", () => {
		const text = pageText("a ".repeat(400));
		expect(text.length).toBe(300);
		expect(text.endsWith("…")).toBe(true);
	});
});

describe("deliverCallback", () => {
	const requests: string[] = [];
	const server = Bun.serve({
		hostname: "::1",
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			requests.push(`${url.pathname}${url.search} host=${req.headers.get("host")}`);
			if (url.pathname === "/redirect") {
				return new Response(null, { status: 302, headers: { location: "https://welcome.example.com/done" } });
			}
			if (url.pathname === "/fail") return new Response("<p>Invalid state</p>", { status: 400 });
			return new Response("<html><body><h1>Signed in</h1><p>Return to your terminal.</p></body></html>", {
				headers: { "content-type": "text/html" },
			});
		},
	});
	const port = server.port as number;
	const opts = { ownPort: GATEWAY_PORT, uid: UID, listeners: [listener(port)] };
	afterAll(() => server.stop(true));

	test("delivers to the listener's own loopback address and returns its answer", async () => {
		const result = await deliverCallback(target(`http://localhost:${port}/oauth/callback?code=abc&state=xyz`), opts);
		expect(result).toEqual({ status: 200, message: "Signed in Return to your terminal." });
		expect(requests.at(-1)).toBe(`/oauth/callback?code=abc&state=xyz host=localhost:${port}`);
	});

	test("reports redirects without following them", async () => {
		const result = await deliverCallback(target(`http://127.0.0.1:${port}/redirect`), opts);
		expect(result).toEqual({ status: 302, message: "Redirected to welcome.example.com" });
	});

	test("passes error statuses through", async () => {
		const result = await deliverCallback(target(`http://localhost:${port}/fail`), opts);
		expect(result).toEqual({ status: 400, message: "Invalid state" });
	});

	test("refuses the gateway's own port", async () => {
		const err = await refusal(
			deliverCallback(target(`http://localhost:${GATEWAY_PORT}/api/me`), {
				...opts,
				listeners: [listener(GATEWAY_PORT)],
			}),
		);
		expect(err.status).toBe(403);
	});

	test("refuses a port another user listens on", async () => {
		const err = await refusal(
			deliverCallback(target(`http://localhost:${port}/cb`), { ...opts, listeners: [listener(port, { uid: 0 })] }),
		);
		expect(err.status).toBe(404);
		expect(err.code).toBe("nothing_listening");
		expect(err.message).toBe(`Nothing on the VM is waiting on port ${port}. Start the sign-in again.`);
		expect(requests.some((r) => r.startsWith("/cb"))).toBe(false);
	});

	test("refuses a port nobody listens on, and one bound to a non-loopback address", async () => {
		expect((await refusal(deliverCallback(target("http://localhost:1/cb"), opts))).status).toBe(404);
		const external = { ...opts, listeners: [listener(port, { scope: "other", address: "10.0.0.5", family: 4 })] };
		expect((await refusal(deliverCallback(target(`http://localhost:${port}/cb`), external))).status).toBe(404);
	});

	test("a request that fails is a 502", async () => {
		const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
		const closedPort = closed.port as number;
		await closed.stop(true);
		const err = await refusal(
			deliverCallback(target(`http://localhost:${closedPort}/cb`), {
				...opts,
				listeners: [listener(closedPort, { family: 4, address: "127.0.0.1" })],
			}),
		);
		expect(err.status).toBe(502);
		expect(err.message).toStartWith(`Couldn't reach port ${closedPort}:`);
	});
});
