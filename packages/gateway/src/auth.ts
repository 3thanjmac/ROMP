import { userInfo } from "node:os";
import type { GatewayConfig } from "./config.ts";
import { HttpError, forbidden } from "./http.ts";
import { peerUids } from "./procnet.ts";
import { type LanSessions, readCookie, sessionCookieName } from "./sessions.ts";

export interface Identity {
	login: string;
	displayName: string;
	avatarUrl: string | null;
}

/** The part of `Bun.Server` auth needs; lets tests pass a stub. */
export interface PeerSource {
	requestIP(req: Request): { port: number } | null;
}

/** Who sent a request. `identity` is null for a LAN connection that has not signed in yet. */
export type Caller = { lan: false; identity: Identity } | { lan: true; identity: Identity | null };

const DEV_IDENTITY: Identity = { login: "dev", displayName: "dev", avatarUrl: null };
const SELF_UID = process.getuid?.() ?? -1;

export class Auth {
	constructor(
		private readonly cfg: Pick<GatewayConfig, "dev" | "allowLogins" | "listen" | "lanProxyUid">,
		private readonly sessions: LanSessions,
	) {}

	/**
	 * Identifies the caller of an HTTP or WebSocket request, or throws.
	 *
	 * Two clients may use the loopback listener. `tailscale serve` (tailscaled, uid 0) sets the
	 * `Tailscale-User-*` headers. The LAN reverse proxy (`lan_proxy_user`) carries no identity, so its
	 * requests must hold a password session cookie. Other Linux users on the VM can reach the same port, so
	 * the owner of the client socket decides which rule applies, and anyone else is refused.
	 */
	identify(req: Request, peers: PeerSource): Caller {
		if (this.cfg.dev) return { lan: false, identity: DEV_IDENTITY };
		const peer = peers.requestIP(req);
		const uids = peer ? peerUids(peer.port, this.cfg.listen.port) : [];
		const lanUid = this.cfg.lanProxyUid;
		if (lanUid !== null && uids.length > 0 && uids.every((uid) => uid === lanUid)) {
			const signedIn = this.sessions.verify(readCookie(req, sessionCookieName(req)));
			if (!signedIn) return { lan: true, identity: null };
			const user = userInfo().username;
			return { lan: true, identity: { login: user, displayName: user, avatarUrl: null } };
		}
		if (uids.length === 0 || !uids.every((uid) => uid === 0 || uid === SELF_UID)) {
			throw forbidden("Connections must come through tailscale serve or the LAN proxy");
		}
		const login = req.headers.get("tailscale-user-login")?.trim();
		if (!login) throw new HttpError(401, "unauthorized", "No Tailscale identity: open the gateway through tailscale serve");
		if (!this.cfg.allowLogins.includes(login.toLowerCase())) throw forbidden(`${login} is not allowed on this gateway`);
		const name = req.headers.get("tailscale-user-name")?.trim();
		return {
			lan: false,
			identity: {
				login,
				displayName: name ? decodeMimeWords(name) : login,
				avatarUrl: req.headers.get("tailscale-user-profile-pic") || null,
			},
		};
	}
}

/**
 * Rejects cross-site WebSocket upgrades and state-changing requests. Tailscale identity is attached by the
 * network and LAN sessions by a cookie, so any page open in the user's browser could otherwise drive the API.
 */
export function crossOriginError(req: Request): string | null {
	const origin = req.headers.get("origin");
	if (origin === null) return null;
	let originHost: string;
	try {
		originHost = new URL(origin).host;
	} catch {
		return `Invalid Origin ${JSON.stringify(origin)}`;
	}
	return originHost === req.headers.get("host")?.toLowerCase() ? null : `Cross-origin request from ${origin} refused`;
}

/** Decodes RFC 2047 encoded words, which tailscaled uses for non-ASCII display names. */
export function decodeMimeWords(value: string): string {
	return value
		.replace(/\?=\s+=\?/g, "?==?")
		.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (word, charset: string, encoding: string, text: string) => {
			if (charset.toLowerCase() !== "utf-8") return word;
			const bytes = encoding.toUpperCase() === "B" ? Buffer.from(text, "base64") : qDecode(text);
			return new TextDecoder().decode(bytes);
		});
}

function qDecode(text: string): Uint8Array {
	const bytes: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const hex = text.slice(i + 1, i + 3);
		if (text[i] === "_") {
			bytes.push(0x20);
		} else if (text[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
			bytes.push(Number.parseInt(hex, 16));
			i += 2;
		} else {
			bytes.push(text.charCodeAt(i));
		}
	}
	return Uint8Array.from(bytes);
}
