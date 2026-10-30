/** Address-field parsing for the browser pane. */

/** "5173" or ":5173" → "/proxy/5173/"; "/proxy/…" and "/absproxy/…" pass through; anything else is a URL. */
export function normalizeAddress(input: string): string | null {
	const text = input.trim();
	if (!text) return null;
	const port = /^:?(\d{1,5})(\/.*)?$/.exec(text);
	if (port) {
		const n = Number(port[1]);
		if (n < 1 || n > 65535) return null;
		return `/proxy/${n}${port[2] ?? "/"}`;
	}
	if (/^\/(abs)?proxy\/\d+$/.test(text)) return `${text}/`;
	if (text.startsWith("/")) return text;
	if (/^https?:\/\//i.test(text)) return text;
	return `https://${text}`;
}

/** The local port a proxied address points at, or null for absolute URLs. */
export function proxiedPort(url: string): number | null {
	const m = /^\/(?:abs)?proxy\/(\d+)\//.exec(url);
	return m ? Number(m[1]) : null;
}

/** Whether the address is on another origin (absolute URL). */
export function isAbsolute(url: string): boolean {
	return /^https?:\/\//i.test(url);
}
