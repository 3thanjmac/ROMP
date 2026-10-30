/** Compact duration for tool cards and thinking headers: 850ms, 1.2s, 12s, 2m 5s, 1h 3m. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	if (ms < 9950) return `${(ms / 1000).toFixed(1)}s`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Elapsed clock for the busy line: 0:42, 12:05, 1:02:03. */
export function formatClock(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const seconds = String(total % 60).padStart(2, "0");
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}
