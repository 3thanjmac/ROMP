import { expect, test } from "bun:test";
import { descendants, DevServerManager, pickDevPort, treePorts } from "../src/devservers.ts";
import { HttpError } from "../src/http.ts";
import { listeningSockets, TCP_LISTEN, type TcpSocket } from "../src/procnet.ts";
import { TerminalManager } from "../src/terminals.ts";

const listener = (localPort: number, inode: number): TcpSocket => ({
	family: 4,
	address: "127.0.0.1",
	scope: "loopback",
	localPort,
	remotePort: 0,
	state: TCP_LISTEN,
	uid: 1000,
	inode,
});

test("ports come from the terminal's whole process tree, preferring the lowest dev-range port", () => {
	// 10 (bash) → 11 (pnpm) → 12 (node vite) → 13 (esbuild); 20 is an unrelated process; 14 a sibling of 11.
	const parents = new Map([
		[10, 1],
		[11, 10],
		[12, 11],
		[13, 12],
		[14, 10],
		[20, 1],
	]);
	const tree = descendants(10, parents);
	expect([...tree].sort()).toEqual([10, 11, 12, 13, 14]);
	expect([...descendants(12, parents)].sort()).toEqual([12, 13]);

	const inodes = new Map([
		[12, [100, 101]],
		[13, [102]],
		[14, [103]],
		[20, [200]],
	]);
	const listeners = [listener(24678, 101), listener(5173, 100), listener(5173, 103), listener(3000, 200), listener(41000, 102)];
	const ports = treePorts(tree, (pid) => inodes.get(pid) ?? [], listeners);
	expect(ports).toEqual([5173, 24678, 41000]);
	expect(pickDevPort(ports)).toBe(5173);
	expect(pickDevPort([41000, 52000])).toBe(41000);
	expect(pickDevPort([])).toBeNull();
});

test("concurrent starts in one folder share a server; stop ends it and its terminal", async () => {
	const terms = new TerminalManager();
	let resolves = 0;
	const gate = Promise.withResolvers<void>();
	const dev = new DevServerManager({
		terms,
		shell: "/bin/bash",
		gatewayPort: 1,
		resolve: async () => {
			resolves++;
			await gate.promise;
			return "sleep 30; true";
		},
		ports: () => [],
	});
	const both = Promise.all([dev.start("/tmp"), dev.start("/tmp")]);
	gate.resolve();
	const [a, b] = await both;
	expect(a.id).toBe(b.id);
	expect((await dev.start("/tmp")).id).toBe(a.id);
	expect(resolves).toBe(1);
	expect(a.state).toBe("starting");
	expect(terms.list().map((t) => t.id)).toEqual([a.termId]);

	expect(await dev.stop(a.id)).toBe(true);
	expect(dev.list()).toEqual([]);
	expect(terms.list()).toEqual([]);
	expect(await dev.stop(a.id)).toBe(false);
});

test("a folder without a dev command is a 422", async () => {
	const dev = new DevServerManager({ terms: new TerminalManager(), shell: "/bin/bash", gatewayPort: 1, resolve: async () => null });
	const err = await dev.start("/tmp").catch((e: unknown) => e);
	expect(err).toBeInstanceOf(HttpError);
	expect((err as HttpError).status).toBe(422);
	expect((err as HttpError).code).toBe("no_dev_command");
});

test("a real server below the shell is found on its port, and stop kills the tree", async () => {
	const terms = new TerminalManager();
	const script = "Bun.serve({ port: 0, fetch: () => new Response('ok') })";
	const dev = new DevServerManager({
		terms,
		shell: "/bin/bash",
		gatewayPort: 1,
		pollMs: 100,
		// `; true` keeps bash as the parent instead of exec'ing bun, so the listener is a descendant.
		resolve: async () => `'${process.execPath}' -e "${script}"; true`,
	});
	const started = await dev.start("/tmp");
	let info = started;
	for (let i = 0; i < 100 && info.state === "starting"; i++) {
		// Real processes binding a real socket: there is no event to await, only the manager's own poll.
		await Bun.sleep(100);
		info = dev.list().find((s) => s.id === started.id) ?? info;
	}
	expect(info.state).toBe("ready");
	const port = info.port ?? 0;
	expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");

	await dev.stop(started.id);
	expect(listeningSockets().some((s) => s.localPort === port)).toBe(false);
}, 20_000);
