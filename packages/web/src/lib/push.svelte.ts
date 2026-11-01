/**
 * Web Push on this device: the service worker (`public/sw.js`), the subscription the gateway sends agent notices to,
 * presence reports that keep the gateway quiet while ROMP is in front of the user, and taps on a notification.
 */
import type { PushPresence, PushSubscriptionInput } from "@romp/protocol";
import { api } from "./api";

/** `install`: iOS/iPadOS Safari, which only offers Web Push to web apps opened from the Home Screen. */
export type PushSupport = "ok" | "install" | "unsupported";

/** Matches the gateway's 40 s presence window with room for one missed report. */
const PRESENCE_INTERVAL_MS = 15_000;

class PushState {
	readonly support: PushSupport = detectSupport();
	permission: NotificationPermission = $state(typeof Notification === "undefined" ? "denied" : Notification.permission);
	/** This device has a subscription. */
	subscribed = $state(false);
	/** False until the existing subscription was looked up. */
	ready = $state(false);
	/** Agent whose notification was tapped; the app root opens it and clears this. */
	tapped: { agentId: string; cwd: string | null } | null = $state(null);
}

export const push = new PushState();

let registration: ServiceWorkerRegistration | null = null;
/** The gateway's VAPID key, fetched ahead so enabling needs as few steps as possible after the tap. */
let serverKey: string | null = null;
let endpoint: string | null = null;
let lastPresence: boolean | null = null;

function detectSupport(): PushSupport {
	if (isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "ok";
	const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
	const homeScreen =
		matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
	return ios && isSecureContext && !homeScreen ? "install" : "unsupported";
}

/** Registers the service worker and picks up this device's subscription. Call once from the app root. */
export async function initPush(): Promise<void> {
	readLaunchTarget();
	if (push.support !== "ok") {
		push.ready = true;
		return;
	}
	navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
		const data = event.data as { type?: unknown; agentId?: unknown; cwd?: unknown } | null;
		if (data?.type === "open-agent" && typeof data.agentId === "string") {
			push.tapped = { agentId: data.agentId, cwd: typeof data.cwd === "string" && data.cwd ? data.cwd : null };
		}
	});
	navigator.serviceWorker.startMessages();
	try {
		registration = await navigator.serviceWorker.register("/sw.js");
		const existing = await registration.pushManager.getSubscription();
		push.permission = Notification.permission;
		if (existing && push.permission === "granted") {
			setEndpoint(existing.endpoint);
			await resync(existing);
		}
	} catch (err) {
		console.warn("push setup failed:", err);
	} finally {
		push.ready = true;
	}
	installPresence();
}

/** Re-sends the subscription (the gateway may have lost it) and renews it if the gateway's key changed. */
async function resync(existing: PushSubscription): Promise<void> {
	serverKey = (await api.push.config()).publicKey;
	let sub = existing;
	if (!sameKey(sub, serverKey)) {
		await sub.unsubscribe();
		setEndpoint(null);
		sub = await subscribe(serverKey);
	}
	await api.push.subscribe(sub.toJSON() as PushSubscriptionInput);
	setEndpoint(sub.endpoint);
}

/** Asks for permission and subscribes this device. Call from a click: browsers only prompt on a user action. */
export async function enablePush(): Promise<void> {
	if (Notification.permission !== "granted") {
		push.permission = await Notification.requestPermission();
		// Denied: the settings page shows how to unblock, so there is nothing to retry.
		if (push.permission === "denied") return;
		if (push.permission !== "granted") throw new Error("Allow notifications when your browser asks.");
	}
	registration ??= await navigator.serviceWorker.register("/sw.js");
	await navigator.serviceWorker.ready;
	serverKey ??= (await api.push.config()).publicKey;
	let sub = await registration.pushManager.getSubscription();
	if (sub && !sameKey(sub, serverKey)) {
		await sub.unsubscribe();
		sub = null;
	}
	sub ??= await subscribe(serverKey);
	await api.push.subscribe(sub.toJSON() as PushSubscriptionInput);
	setEndpoint(sub.endpoint);
}

export async function disablePush(): Promise<void> {
	if (endpoint) await api.push.unsubscribe(endpoint);
	const sub = await registration?.pushManager.getSubscription();
	await sub?.unsubscribe();
	setEndpoint(null);
}

/** Has the gateway push a test notification to this device; it shows even while ROMP is open. */
export async function testPush(): Promise<void> {
	if (!endpoint) throw new Error("Notifications are off for this device.");
	await api.push.test(endpoint);
}

function subscribe(key: string): Promise<PushSubscription> {
	if (!registration) throw new Error("The service worker is not registered.");
	return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64url(key) });
}

function setEndpoint(value: string | null): void {
	endpoint = value;
	push.subscribed = value !== null;
	lastPresence = null;
	reportPresence();
}

function sameKey(sub: PushSubscription, key: string): boolean {
	const current = sub.options.applicationServerKey;
	return current !== null && toBase64url(new Uint8Array(current)) === key;
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function toBase64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Presence ──

function watching(): boolean {
	return document.visibilityState === "visible" && document.hasFocus();
}

/** Tells the gateway whether ROMP is in front of the user on this device: on changes, and every interval while it is. */
function reportPresence(active = watching(), repeat = false): void {
	if (!endpoint || (!repeat && active === lastPresence)) return;
	lastPresence = active;
	// keepalive: the report that the page is going away has to outlive it.
	void fetch("/api/push/presence", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ endpoint, active } satisfies PushPresence),
		keepalive: true,
	}).catch(() => {});
}

function installPresence(): void {
	const changed = () => reportPresence();
	document.addEventListener("visibilitychange", changed);
	addEventListener("focus", changed);
	addEventListener("blur", changed);
	addEventListener("pagehide", () => reportPresence(false));
	setInterval(() => (watching() ? reportPresence(true, true) : reportPresence()), PRESENCE_INTERVAL_MS);
}

// ── Taps that opened the app ──

/** The service worker opens `/?agent=<id>&cwd=<dir>` when no ROMP window was open. */
function readLaunchTarget(): void {
	const params = new URLSearchParams(location.search);
	const agentId = params.get("agent");
	if (!agentId) return;
	push.tapped = { agentId, cwd: params.get("cwd") || null };
	params.delete("agent");
	params.delete("cwd");
	const query = params.size > 0 ? `?${params}` : "";
	history.replaceState(history.state, "", `${location.pathname}${query}${location.hash}`);
}
