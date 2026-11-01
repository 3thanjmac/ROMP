/**
 * Web Push sending without dependencies: message encryption (RFC 8291, `aes128gcm` from RFC 8188) and VAPID
 * authentication (RFC 8292), all on WebCrypto.
 */
import type { webcrypto } from "node:crypto";

type Bytes = Uint8Array<ArrayBuffer>;

/** One record holds the whole message; payloads are kept far below this. */
const RECORD_SIZE = 4096;
/** Plaintext limit for a single record: the delimiter byte and the 16-byte GCM tag share the record. */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - 17;
const VAPID_TTL_S = 12 * 60 * 60;
const SEND_TIMEOUT_MS = 15_000;

const text = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

export function fromBase64url(value: string): Bytes {
	return new Uint8Array(Buffer.from(value, "base64url"));
}

function concat(...parts: Uint8Array[]): Bytes {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** The sender's ephemeral ECDH key: `publicKey` is the uncompressed P-256 point. */
export interface SenderKey {
	privateKey: CryptoKey;
	publicKey: Bytes;
}

async function ephemeralKey(): Promise<SenderKey> {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

/**
 * Encrypts `plaintext` for a subscription's `p256dh` key and `auth` secret (both base64url). `salt` and `sender` are
 * fresh per message unless given (tests pin them to reproduce the RFC 8291 example).
 */
export async function encryptPayload(
	plaintext: Uint8Array,
	p256dh: string,
	auth: string,
	fixed?: { salt: Bytes; sender: SenderKey },
): Promise<Bytes> {
	if (plaintext.length > MAX_PAYLOAD_BYTES) throw new Error(`push payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
	const receiver = fromBase64url(p256dh);
	const secret = fromBase64url(auth);
	if (receiver.length !== 65 || receiver[0] !== 4) throw new Error("p256dh must be an uncompressed P-256 public key");
	if (secret.length !== 16) throw new Error("auth must be 16 bytes");
	const sender = fixed?.sender ?? (await ephemeralKey());
	const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));

	const receiverKey = await crypto.subtle.importKey("raw", receiver, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const shared = new Uint8Array(
		await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, sender.privateKey, 256),
	);
	const ikm = await hkdf(secret, shared, concat(text.encode("WebPush: info\0"), receiver, sender.publicKey), 32);
	const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);

	const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	// 0x02 marks the last (only) record; no extra padding.
	const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, Uint8Array.of(2)));
	const header = new Uint8Array(21);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, RECORD_SIZE);
	header[20] = sender.publicKey.length;
	return concat(header, sender.publicKey, new Uint8Array(sealed));
}

/** The gateway's application server key pair (RFC 8292), persisted as JWK. */
export interface VapidKeys {
	/** Uncompressed P-256 point, base64url: the browser's `applicationServerKey`. */
	publicKey: string;
	privateJwk: webcrypto.JsonWebKey;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	return { publicKey: base64url(publicKey), privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}

export class Vapid {
	private constructor(
		readonly publicKey: string,
		private readonly signingKey: CryptoKey,
	) {}

	static async load(keys: VapidKeys): Promise<Vapid> {
		const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
			"sign",
		]);
		return new Vapid(keys.publicKey, key);
	}

	/**
	 * The `Authorization` header for a push service. `subject` must be an `https:` URL or `mailto:` address that is
	 * not on localhost: Apple's service refuses the token otherwise.
	 */
	async authorization(endpoint: string, subject: string): Promise<string> {
		const encode = (value: object) => base64url(text.encode(JSON.stringify(value)));
		const claims = { aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + VAPID_TTL_S, sub: subject };
		const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode(claims)}`;
		// WebCrypto ECDSA signatures are already the raw r||s form JWS wants.
		const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.signingKey, text.encode(unsigned));
		return `vapid t=${unsigned}.${base64url(new Uint8Array(signature))}, k=${this.publicKey}`;
	}
}

export interface PushTarget {
	endpoint: string;
	p256dh: string;
	auth: string;
	/** VAPID `sub` claim. */
	subject: string;
}

export interface PushResult {
	ok: boolean;
	status: number;
	/** The subscription is gone for good (404/410) and should be forgotten. */
	expired: boolean;
	/** Push service explanation when it refused the message. */
	error: string | null;
}

/** Encrypts and posts one message. Network failures reject; push service refusals resolve with `ok: false`. */
export async function sendPush(vapid: Vapid, target: PushTarget, payload: string, ttlSeconds: number): Promise<PushResult> {
	const body = await encryptPayload(text.encode(payload), target.p256dh, target.auth);
	const res = await fetch(target.endpoint, {
		method: "POST",
		headers: {
			authorization: await vapid.authorization(target.endpoint, target.subject),
			"content-encoding": "aes128gcm",
			"content-type": "application/octet-stream",
			ttl: String(ttlSeconds),
			urgency: "high",
		},
		body,
		signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
	});
	if (res.ok) {
		await res.body?.cancel();
		return { ok: true, status: res.status, expired: false, error: null };
	}
	const detail = (await res.text().catch(() => "")).trim().slice(0, 300);
	return {
		ok: false,
		status: res.status,
		expired: res.status === 404 || res.status === 410,
		error: `push service answered ${res.status}${detail ? `: ${detail}` : ""}`,
	};
}
