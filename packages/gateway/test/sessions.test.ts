import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "../src/http.ts";
import { LanSessions, SESSION_IDLE_MS, readCookie, sessionCookieName, stripSessionCookies } from "../src/sessions.ts";

const root = mkdtempSync(join(tmpdir(), "romp-sessions-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

async function setup(password: string | null = "correct horse") {
	const dir = join(root, String(++n));
	const passwordFile = join(dir, "password");
	const stateDir = join(dir, "state");
	const clock = { now: 1_000_000 };
	if (password !== null) {
		await Bun.write(passwordFile, `${await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 1024, timeCost: 1 })}\n`);
	}
	const make = () => new LanSessions(passwordFile, stateDir, () => clock.now);
	return { passwordFile, stateDir, clock, make, sessions: make() };
}

async function status(promise: Promise<unknown>): Promise<number> {
	try {
		await promise;
		return 200;
	} catch (err) {
		if (err instanceof HttpError) return err.status;
		throw err;
	}
}

describe("LanSessions", () => {
	test("a correct password yields a token that verifies, and survives a gateway restart", async () => {
		const { sessions, make } = await setup();
		const token = await sessions.login("correct horse");
		expect(sessions.verify(token)).toBe(true);
		expect(sessions.verify("forged")).toBe(false);
		expect(sessions.verify(null)).toBe(false);
		await sessions.flush();
		const restarted = make();
		await restarted.load();
		expect(restarted.verify(token)).toBe(true);
	});

	test("without a password file, sign-in is refused with 403 and nothing verifies", async () => {
		const { sessions } = await setup(null);
		expect(await status(sessions.login("anything"))).toBe(403);
		expect(sessions.verify("anything")).toBe(false);
	});

	test("changing or removing the password signs every session out", async () => {
		const { sessions, passwordFile } = await setup();
		const token = await sessions.login("correct horse");
		const later = new Date(Date.now() + 10_000);
		utimesSync(passwordFile, later, later);
		expect(sessions.verify(token)).toBe(false);
		const again = await sessions.login("correct horse");
		expect(sessions.verify(again)).toBe(true);
		rmSync(passwordFile);
		expect(sessions.verify(again)).toBe(false);
	});

	test("sessions expire after the idle timeout, and use keeps them alive", async () => {
		const { sessions, clock } = await setup();
		const token = await sessions.login("correct horse");
		clock.now += SESSION_IDLE_MS - 1;
		expect(sessions.verify(token)).toBe(true);
		clock.now += SESSION_IDLE_MS - 1;
		expect(sessions.verify(token)).toBe(true);
		clock.now += SESSION_IDLE_MS + 1;
		expect(sessions.verify(token)).toBe(false);
	});

	test("five wrong passwords lock sign-in, even for the right one, until the lockout passes", async () => {
		const { sessions, clock } = await setup();
		for (let i = 0; i < 5; i++) expect(await status(sessions.login("wrong"))).toBe(401);
		expect(await status(sessions.login("correct horse"))).toBe(429);
		clock.now += 30_000;
		expect(await status(sessions.login("correct horse"))).toBe(200);
		// Success resets the counter: one more miss is a plain 401 again.
		expect(await status(sessions.login("wrong"))).toBe(401);
		expect(await status(sessions.login("correct horse"))).toBe(200);
	});
});

describe("session cookies", () => {
	const req = (host: string, cookie?: string) =>
		new Request(`https://${host}/`, { headers: { host, ...(cookie === undefined ? {} : { cookie }) } });

	test("each HTTPS port gets its own cookie, so people sharing a hostname stay separate", () => {
		expect(sessionCookieName(req("vm.tail1.ts.net"))).toBe("__Host-romp-443");
		expect(sessionCookieName(req("vm.tail1.ts.net:8443"))).toBe("__Host-romp-8443");
		const both = req("vm.tail1.ts.net:8443", "__Host-romp-443=alice; __Host-romp-8443=bob");
		expect(readCookie(both, sessionCookieName(both))).toBe("bob");
	});

	test("proxied dev servers get their own cookies but never a ROMP session", () => {
		expect(stripSessionCookies("a=1; __Host-romp-443=t; b=2")).toBe("a=1; b=2");
		expect(stripSessionCookies("__Host-romp-443=t")).toBeNull();
	});
});
