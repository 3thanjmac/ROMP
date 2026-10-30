/**
 * Reachability shared by the API client, sockets and the top bar's offline chip. `gatewayDown` flips on when a
 * request cannot reach the gateway and back off on the next success; while down, /api/me is probed.
 */

const PROBE_MS = 5000;

class Net {
	browserOnline = $state(true);
	gatewayDown = $state(false);
	#probe: number | undefined;

	get offline(): boolean {
		return !this.browserOnline || this.gatewayDown;
	}

	reportUp(): void {
		if (!this.gatewayDown) return;
		this.gatewayDown = false;
		clearTimeout(this.#probe);
	}

	reportDown(): void {
		if (this.gatewayDown) return;
		this.gatewayDown = true;
		this.#scheduleProbe();
	}

	probeNow(): void {
		if (!this.gatewayDown) return;
		clearTimeout(this.#probe);
		void this.#runProbe();
	}

	#scheduleProbe(): void {
		clearTimeout(this.#probe);
		this.#probe = window.setTimeout(() => void this.#runProbe(), PROBE_MS);
	}

	async #runProbe(): Promise<void> {
		try {
			const res = await fetch("/api/me", { cache: "no-store" });
			if (res.ok) {
				this.reportUp();
				return;
			}
		} catch {
			// still unreachable
		}
		if (this.gatewayDown) this.#scheduleProbe();
	}
}

export const net = new Net();

export function initNet(): void {
	net.browserOnline = navigator.onLine;
	window.addEventListener("online", () => {
		net.browserOnline = true;
		net.probeNow();
	});
	window.addEventListener("offline", () => {
		net.browserOnline = false;
	});
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") net.probeNow();
	});
}
