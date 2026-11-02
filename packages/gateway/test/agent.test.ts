import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AgentServerMsg } from "@romp/protocol";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentRecord } from "../src/agents/agent.ts";
import type { Socket } from "../src/ws.ts";

type Snapshot = Extract<AgentServerMsg, { t: "snapshot" }>;
type Frame = Extract<AgentServerMsg, { t: "frame" }>["frame"];

/** The socket methods Agent uses, recording what it was sent and waking waiters on every change. */
class FakeSocket {
	readonly messages: AgentServerMsg[] = [];
	closed: { code: number; reason: string } | null = null;
	private wake: (() => void)[] = [];

	send(data: string): void {
		this.messages.push(JSON.parse(data));
		for (const resolve of this.wake.splice(0)) resolve();
	}
	close(code: number, reason: string): void {
		this.closed = { code, reason };
		for (const resolve of this.wake.splice(0)) resolve();
	}

	get socket(): Socket {
		return this as unknown as Socket; // structural stand-in for Bun's ServerWebSocket
	}
	frames(type: string): Frame[] {
		return this.messages.flatMap((m) => (m.t === "frame" && m.frame.type === type ? [m.frame] : []));
	}
	snapshots(): Snapshot[] {
		return this.messages.filter((m): m is Snapshot => m.t === "snapshot");
	}
	response(reqId: string) {
		return this.messages.find((m) => m.t === "response" && m.reqId === reqId);
	}
	async until(pred: () => boolean, what: string): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (!pred()) {
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`timed out waiting for ${what}`);
			const { promise, resolve } = Promise.withResolvers<void>();
			this.wake.push(resolve);
			const timer = setTimeout(resolve, left);
			await promise;
			clearTimeout(timer);
		}
	}
}

let dir: string;
let omp: string;
const agents: Agent[] = [];

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "romp-agent-"));
	omp = join(dir, "omp");
	const fake = join(import.meta.dir, "fixtures/fake-omp.ts");
	writeFileSync(omp, `#!/bin/sh\nexport FAKE_OMP_DIR=${dir}\nexec ${process.execPath} ${fake} "$@"\n`);
	chmodSync(omp, 0o755);
});

afterAll(async () => {
	await Promise.all(agents.map((agent) => agent.close(1001, "done")));
	rmSync(dir, { recursive: true, force: true });
});

function makeAgent(id: string, prompt?: string, sessionFile: string | null = null): Agent {
	const record: AgentRecord = { id, title: id, cwd: dir, createdAt: 1, sessionFile };
	const agent = new Agent(record, null, { omp, persist: () => {}, busyChanged: () => {}, notify: () => {} }, prompt);
	agents.push(agent);
	return agent;
}

test("streams a turn, tracks busy, routes responses to the sender only, resumes after respawn", async () => {
	const agent = makeAgent("a1", "hello");
	const a = new FakeSocket();
	const b = new FakeSocket();
	agent.attach(a.socket);
	await a.until(() => JSON.stringify(a.messages).includes("echo:hello"), "first turn");
	agent.attach(b.socket);
	await b.until(() => b.snapshots().length > 0, "snapshot b");
	const [snapshot] = b.snapshots();
	expect(JSON.stringify(snapshot?.messages)).toContain("echo:hello");
	expect(snapshot?.info.clients).toBe(2);

	await agent.rpc(a.socket, "q1", { type: "prompt", message: "big" });
	await a.until(() => a.response("q1") !== undefined, "prompt response");
	expect(b.messages.some((m) => m.t === "response")).toBe(false);
	await b.until(() => b.frames("agent_end").length > 0, "big turn on b");
	// The >1 MiB message_end arrives as rpc_chunk frames and is forwarded reassembled.
	expect(JSON.stringify(b.frames("message_end").at(-1)).length).toBeGreaterThan(1_200_000);
	const busy = b.messages.flatMap((m) => (m.t === "info" ? [m.info.busy] : []));
	expect(busy).toContain(true);
	expect(busy.at(-1)).toBe(false);

	await agent.stop();
	await a.until(() => a.messages.some((m) => m.t === "exit"), "exit");
	const { sessionFile } = agent.toRecord();
	expect(sessionFile).toMatch(/session-\d+\.json$/);

	// A new Agent over the persisted record (as after a gateway restart) resumes via switch_session.
	const c = new FakeSocket();
	makeAgent("a1b", undefined, sessionFile).attach(c.socket);
	await c.until(() => c.snapshots().length > 0, "resumed snapshot");
	expect(JSON.stringify(c.snapshots()[0]?.messages)).toContain("echo:hello");
});

test("pending extension UI appears in snapshots until answered, and answers are broadcast", async () => {
	const agent = makeAgent("a2", "ask");
	const a = new FakeSocket();
	agent.attach(a.socket);
	// The request is raised during startup, before `a` joined, so it arrives through the snapshot.
	await a.until(() => a.snapshots().length > 0, "snapshot a");
	expect(a.snapshots()[0]?.pendingUi).toHaveLength(1);
	const b = new FakeSocket();
	agent.attach(b.socket);
	await b.until(() => b.snapshots().length > 0, "snapshot b");
	expect(b.snapshots()[0]?.pendingUi).toHaveLength(1);

	agent.answerUi({ type: "extension_ui_response", id: "ui1", confirmed: true });
	expect(a.frames("extension_ui_response")).toHaveLength(1);
	expect(b.frames("extension_ui_response")).toHaveLength(1);
	await a.until(() => a.frames("notice").length > 0, "omp saw the answer");

	const c = new FakeSocket();
	agent.attach(c.socket);
	await c.until(() => c.snapshots().length > 0, "snapshot after answer");
	expect(c.snapshots()[0]?.pendingUi).toEqual([]);
});

test("a client rpc after the process exited respawns it and re-snapshots clients", async () => {
	const agent = makeAgent("a3");
	const a = new FakeSocket();
	agent.attach(a.socket);
	await a.until(() => a.snapshots().length > 0, "snapshot");
	await agent.stop();
	await a.until(() => a.messages.some((m) => m.t === "exit"), "exit");
	await agent.rpc(a.socket, "r", { type: "get_state" });
	await a.until(() => a.response("r") !== undefined, "response after respawn");
	expect(a.response("r")).toMatchObject({ success: true });
	await a.until(() => a.snapshots().length === 2, "fresh snapshot after respawn");
	expect(agent.info().exited).toBe(false);
});

test("an omp that exits before ready reports its stderr and closes 4503 instead of a retryable error", async () => {
	const failing = join(dir, "omp-unconfigured");
	writeFileSync(
		failing,
		`#!/bin/sh\nprintf 'No default model selected. Use /login.\\n\\nSet an API key environment variable.\\n' >&2\nexit 1\n`,
	);
	chmodSync(failing, 0o755);
	const record: AgentRecord = { id: "a4", title: "a4", cwd: dir, createdAt: 1, sessionFile: null };
	const agent = new Agent(record, null, { omp: failing, persist: () => {}, busyChanged: () => {}, notify: () => {} }, undefined);
	agents.push(agent);
	const a = new FakeSocket();
	agent.attach(a.socket);
	await a.until(() => a.closed !== null, "close");
	expect(a.closed?.code).toBe(4503);
	expect(a.messages.filter((m) => m.t === "error")).toEqual([
		{ t: "error", message: "omp exited with code 1: No default model selected. Use /login." },
	]);
	expect(a.snapshots()).toEqual([]);
});

test("setTitle renames the agent, tells clients, and names the OMP session", async () => {
	const agent = makeAgent("a5");
	const a = new FakeSocket();
	agent.attach(a.socket);
	await a.until(() => a.snapshots().length > 0, "snapshot");
	await agent.setTitle("Fix the login flow");
	expect(agent.info().title).toBe("Fix the login flow");
	expect(agent.toRecord().title).toBe("Fix the login flow");
	expect(a.messages.some((m) => m.t === "info" && m.info.title === "Fix the login flow")).toBe(true);
	await agent.rpc(a.socket, "s", { type: "get_state" });
	await a.until(() => a.response("s") !== undefined, "state");
	expect(a.response("s")).toMatchObject({ success: true, data: { sessionName: "Fix the login flow" } });
});
