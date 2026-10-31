import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError, forbidden } from "./http.ts";
import { errnoCode, errorMessage, isRecord, writeFileAtomic } from "./util.ts";

/** A LAN session ends after this long without a request. */
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** `lastUsed` is written to disk at most this often per session. */
const TOUCH_PERSIST_MS = 60 * 60 * 1000;
/** Browsers cap cookie lifetimes at 400 days; the server-side idle timeout is what ends a session. */
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
const FREE_ATTEMPTS = 5;
const FIRST_LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 15 * 60_000;
const COOKIE_PREFIX = "__Host-romp-";

interface StoredSession {
	/** sha256 of the cookie token, hex. */
	hash: string;
	createdAt: number;
	lastUsed: number;
}

interface SessionsFile {
	/** mtime of the password file the sessions were created under; a new password signs everyone out. */
	passwordMtimeMs: number | null;
	sessions: StoredSession[];
}

/**
 * Password sign-in for connections from the LAN reverse proxy. Sessions are random cookie tokens whose sha256
 * is kept in `<state_dir>/sessions.json`, so a leaked state file does not grant access.
 */
export class LanSessions {
	private readonly file: string;
	private passwordMtimeMs: number | null = null;
	private sessions = new Map<string, StoredSession>();
	private saving: Promise<void> = Promise.resolve();
	private failures = 0;
	private lockedUntil = 0;

	constructor(
		private readonly passwordFile: string,
		private readonly stateDir: string,
		private readonly now: () => number = Date.now,
	) {
		this.file = join(stateDir, "sessions.json");
	}

	async load(): Promise<void> {
		let text: string;
		try {
			text = await readFile(this.file, "utf8");
		} catch (err) {
			if (errnoCode(err) === "ENOENT") return;
			throw err;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			console.warn(`${this.file}: ${errorMessage(err)}; starting with no sessions`);
			return;
		}
		if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) return;
		this.passwordMtimeMs = typeof parsed.passwordMtimeMs === "number" ? parsed.passwordMtimeMs : null;
		for (const item of parsed.sessions) {
			if (isStoredSession(item)) this.sessions.set(item.hash, item);
		}
	}

	/** True when `token` names a live session under the current password. */
	verify(token: string | null): boolean {
		if (!token || !this.syncPassword()) return false;
		const hash = sha256(token);
		const session = this.sessions.get(hash);
		if (!session) return false;
		const now = this.now();
		if (now - session.lastUsed > SESSION_IDLE_MS) {
			this.sessions.delete(hash);
			this.persist();
			return false;
		}
		const stale = now - session.lastUsed > TOUCH_PERSIST_MS;
		session.lastUsed = now;
		if (stale) this.persist();
		return true;
	}

	/** Checks the password and returns a new session token. Throws 403 when no password is set, 401/429 on failure. */
	async login(password: string): Promise<string> {
		const hash = this.readPasswordHash();
		const now = this.now();
		if (now < this.lockedUntil) {
			throw new HttpError(429, "rate_limited", `Too many attempts. Try again in ${Math.ceil((this.lockedUntil - now) / 1000)} s.`);
		}
		if (!(await Bun.password.verify(password, hash))) {
			this.failures++;
			if (this.failures >= FREE_ATTEMPTS) {
				this.lockedUntil = this.now() + Math.min(FIRST_LOCKOUT_MS * 2 ** (this.failures - FREE_ATTEMPTS), MAX_LOCKOUT_MS);
			}
			throw new HttpError(401, "bad_password", "Wrong password.");
		}
		this.failures = 0;
		this.lockedUntil = 0;
		this.syncPassword();
		const token = randomBytes(32).toString("base64url");
		this.sessions.set(sha256(token), { hash: sha256(token), createdAt: now, lastUsed: now });
		this.persist();
		return token;
	}

	private readPasswordHash(): string {
		let text: string;
		try {
			text = readFileSync(this.passwordFile, "utf8").trim();
		} catch (err) {
			if (errnoCode(err) !== "ENOENT") throw err;
			text = "";
		}
		if (!text) throw forbidden("No password is set for this gateway. Run `romp-gateway passwd` on the VM to set one.");
		return text;
	}

	/** Drops every session when the password file changed or vanished. Returns whether a password is set. */
	private syncPassword(): boolean {
		let mtime: number | null;
		try {
			mtime = statSync(this.passwordFile).mtimeMs;
		} catch {
			mtime = null;
		}
		if (mtime !== this.passwordMtimeMs) {
			this.passwordMtimeMs = mtime;
			if (this.sessions.size > 0) this.sessions.clear();
			this.persist();
		}
		return mtime !== null;
	}

	/** Resolves once every change so far is on disk. */
	async flush(): Promise<void> {
		await this.saving;
	}

	private persist(): void {
		const data: SessionsFile = { passwordMtimeMs: this.passwordMtimeMs, sessions: [...this.sessions.values()] };
		this.saving = this.saving
			.then(async () => {
				await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
				await writeFileAtomic(this.file, `${JSON.stringify(data)}\n`, 0o600);
			})
			.catch((err: unknown) => console.error(`saving ${this.file}: ${errorMessage(err)}`));
	}
}

/**
 * The session cookie's name. People share one hostname and differ by HTTPS port, and cookies ignore ports,
 * so the port is part of the name to keep each person's session separate.
 */
export function sessionCookieName(req: Request): string {
	const host = req.headers.get("host") ?? "";
	const port = /:(\d+)$/.exec(host)?.[1] ?? "443";
	return `${COOKIE_PREFIX}${port}`;
}

export function readCookie(req: Request, name: string): string | null {
	for (const part of (req.headers.get("cookie") ?? "").split(";")) {
		const eq = part.indexOf("=");
		if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return null;
}

export function sessionCookie(name: string, token: string): string {
	return `${name}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}`;
}

/** Removes ROMP session cookies from a Cookie header bound for a proxied dev server. Null when none remain. */
export function stripSessionCookies(header: string): string | null {
	const kept = header
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part !== "" && !part.startsWith(COOKIE_PREFIX));
	return kept.length > 0 ? kept.join("; ") : null;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function isStoredSession(value: unknown): value is StoredSession {
	return (
		isRecord(value) &&
		typeof value.hash === "string" &&
		typeof value.createdAt === "number" &&
		typeof value.lastUsed === "number"
	);
}
