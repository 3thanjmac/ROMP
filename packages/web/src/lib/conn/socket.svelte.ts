/**
 * Reconnecting JSON WebSocket with the shared connection states every live pane shows:
 * connecting (first attempt) → live → reconnecting (backoff 0.5, 1, 2, 4, 8s, then every 10s) | offline
 * (navigator.onLine is false) | exited (the session ended or no longer exists; no more reconnects) | failed (the
 * server could not start the session; no more reconnects until `retryNow`).
 * Reconnects immediately when the tab becomes visible again and when the browser comes back online.
 */
import { net } from "./net.svelte";

export type ConnState = "connecting" | "live" | "reconnecting" | "offline" | "exited" | "failed";

export interface SocketOptions<In> {
	/** Path on this origin, e.g. `/ws/term/<id>`. */
	path: string;
	onMessage(msg: In): void;
	/** After every successful (re)connect. */
	onOpen?(): void;
	/**
	 * Asked before each reconnect attempt. Resolve false when the resource is gone (the socket then goes
	 * `exited`); reject when it cannot be determined (the attempt proceeds).
	 */
	stillExists?(): Promise<boolean>;
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const MAX_BACKOFF_MS = 10_000;
/** Server close codes meaning "this session does not exist (any more)": stop reconnecting. */
const GONE_CODES = new Set([4404, 4410]);
/** Server close code meaning "the session could not start": retrying needs the user to fix something first. */
const FAILED_CODE = 4503;

export class Socket<In, Out> {
	state: ConnState = $state("connecting");
	/**
	 * Reconnect attempts since a connection last delivered a message. An `open` alone does not count: a server that
	 * accepts and then immediately closes would otherwise be retried at the shortest backoff forever.
	 */
	attempt = $state(0);

	#opts: SocketOptions<In>;
	#ws: WebSocket | null = null;
	#timer: number | undefined;
	#disposed = false;

	constructor(opts: SocketOptions<In>) {
		this.#opts = opts;
		window.addEventListener("online", this.#onOnline);
		window.addEventListener("offline", this.#onOffline);
		document.addEventListener("visibilitychange", this.#onVisibility);
		if (navigator.onLine) this.#connect();
		else this.state = "offline";
	}

	/** Sends when live; returns false (and drops the message) otherwise. */
	send(msg: Out): boolean {
		const ws = this.#ws;
		if (this.state !== "live" || !ws || ws.readyState !== WebSocket.OPEN) return false;
		ws.send(JSON.stringify(msg));
		return true;
	}

	/** Skip the backoff wait and reconnect now. */
	retryNow(): void {
		if (this.#disposed || this.state === "exited" || this.state === "live") return;
		clearTimeout(this.#timer);
		this.#connect();
	}

	/** The session ended (the server said so): close and stop reconnecting. */
	exit(): void {
		this.state = "exited";
		clearTimeout(this.#timer);
		this.#close();
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#timer);
		this.#close();
		window.removeEventListener("online", this.#onOnline);
		window.removeEventListener("offline", this.#onOffline);
		document.removeEventListener("visibilitychange", this.#onVisibility);
	}

	#connect(): void {
		this.#close();
		const url = new URL(this.#opts.path, location.href);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(url);
		this.#ws = ws;
		// A retry after `failed` is a fresh start, not the recovery of a dropped connection.
		this.state = this.attempt === 0 && (this.state === "connecting" || this.state === "failed") ? "connecting" : "reconnecting";
		ws.onopen = () => {
			if (ws !== this.#ws) return;
			this.state = "live";
			net.reportUp();
			this.#opts.onOpen?.();
		};
		let delivered = false;
		ws.onmessage = (ev) => {
			if (ws !== this.#ws || typeof ev.data !== "string") return;
			if (!delivered) {
				delivered = true;
				this.attempt = 0;
			}
			let msg: In;
			try {
				msg = JSON.parse(ev.data) as In;
			} catch {
				return;
			}
			this.#opts.onMessage(msg);
		};
		ws.onclose = (ev) => {
			if (ws !== this.#ws) return;
			this.#ws = null;
			this.#dropped(ev.code);
		};
	}

	#close(): void {
		const ws = this.#ws;
		this.#ws = null;
		if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
	}

	#dropped(code: number): void {
		if (this.#disposed || this.state === "exited") return;
		if (GONE_CODES.has(code)) {
			this.state = "exited";
			return;
		}
		if (code === FAILED_CODE) {
			this.state = "failed";
			return;
		}
		if (!navigator.onLine) {
			this.state = "offline";
			return;
		}
		this.attempt += 1;
		this.state = "reconnecting";
		const delay = BACKOFF_MS[this.attempt - 1] ?? MAX_BACKOFF_MS;
		clearTimeout(this.#timer);
		this.#timer = window.setTimeout(() => void this.#retry(), delay);
	}

	async #retry(): Promise<void> {
		if (this.#disposed || this.state === "exited" || this.state === "live") return;
		if (this.#opts.stillExists) {
			try {
				if (!(await this.#opts.stillExists())) {
					if (!this.#disposed) this.state = "exited";
					return;
				}
			} catch {
				// Unknown (gateway unreachable): try the socket anyway.
			}
			if (this.#disposed || (this.state as ConnState) === "exited" || (this.state as ConnState) === "live") return;
		}
		this.#connect();
	}

	#onOnline = (): void => {
		if (this.state === "offline" || this.state === "reconnecting") this.retryNow();
	};

	#onOffline = (): void => {
		if (this.state === "exited" || this.#disposed) return;
		clearTimeout(this.#timer);
		this.#close();
		this.state = "offline";
	};

	#onVisibility = (): void => {
		if (document.visibilityState === "visible" && this.state === "reconnecting") this.retryNow();
	};
}
