import { expect, test } from "bun:test";
import { describeProcess, parseProcNetTcp, TCP_LISTEN } from "../src/procnet.ts";

test("describeProcess names interpreter scripts, falls back to comm for inline code", () => {
	expect(describeProcess(["node", "/app/node_modules/.bin/vite", "--port", "5173"], "node")).toBe("vite");
	expect(describeProcess(["python3", "-m", "http.server", "8000"], "python3")).toBe("http.server");
	expect(describeProcess(["bun", "run", "dev.ts"], "bun")).toBe("dev");
	expect(describeProcess(["node", "-r", "ts-node/register", "server.ts"], "node")).toBe("server");
	expect(describeProcess(["node", "-e", "require('http').createServer().listen(8123)"], "node")).toBe("node");
	expect(describeProcess(["python3", "-c", "import x"], "python3")).toBe("python3");
	expect(describeProcess(["/usr/sbin/nginx", "-g", "daemon off;"], "nginx")).toBe("nginx");
});

test("parseProcNetTcp decodes v4, v6 and v4-mapped listeners", () => {
	const v4 = parseProcNetTcp(
		"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
			"   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1\n",
		false,
	);
	expect(v4).toEqual([
		{ family: 4, address: "127.0.0.1", scope: "loopback", localPort: 8080, remotePort: 0, state: TCP_LISTEN, uid: 1000, inode: 12345 },
	]);
	const v6 = parseProcNetTcp(
		"  sl\n" +
			"   0: 00000000000000000000000001000000:1F91 00000000000000000000000000000000:0000 0A 0:0 00:0 0 1000 0 1 1\n" +
			"   1: 0000000000000000FFFF00000100007F:1F92 00000000000000000000000000000000:0000 0A 0:0 00:0 0 1000 0 2 1\n" +
			"   2: 00000000000000000000000000000000:1F93 00000000000000000000000000000000:0000 0A 0:0 00:0 0 1000 0 3 1\n",
		true,
	);
	expect(v6.map((s) => [s.address, s.scope, s.localPort])).toEqual([
		["::1", "loopback", 8081],
		["127.0.0.1", "loopback", 8082],
		["::", "any", 8083],
	]);
});
