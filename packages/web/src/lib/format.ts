/** Small formatting helpers shared by panes and chrome. */

export function basename(path: string): string {
	const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
	const i = trimmed.lastIndexOf("/");
	return i < 0 ? trimmed : trimmed.slice(i + 1) || "/";
}

export function dirname(path: string): string {
	const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
	const i = trimmed.lastIndexOf("/");
	if (i <= 0) return "/";
	return trimmed.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
	return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** `/home/me/romp/app` → `~/romp/app` when under `home`. */
export function tildify(path: string, home: string | null | undefined): string {
	if (!home) return path;
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Expands a leading `~` against `home`. */
export function untildify(path: string, home: string | null | undefined): string {
	if (!home) return path;
	if (path === "~") return home;
	return path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatSize(bytes: number): string {
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const digits = unit === 0 || value >= 10 ? 0 : 1;
	return `${value.toFixed(digits)} ${SIZE_UNITS[unit]}`;
}

/** Compact age: "now", "42s", "5m", "3h", "2d", "6w", "1y". */
export function relativeTime(ms: number, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 10) return "now";
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d`;
	if (d < 365) return `${Math.floor(d / 7)}w`;
	return `${Math.floor(d / 365)}y`;
}

/** Random id that works on insecure origins too (no crypto.randomUUID there). */
export function uid(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(9));
	return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 14);
}
