/** Toast queue rendered by Toaster.svelte. Max 3 visible; 5s, or 8s with an action; hover/focus pauses. */

export type ToastTone = "neutral" | "success" | "danger";
export type ToastCloseReason = "timeout" | "action" | "dismiss" | "evicted";

export interface ToastAction {
	label: string;
	run: () => void;
}

export interface ToastOptions {
	message: string;
	action?: ToastAction;
	tone?: ToastTone;
	/** Milliseconds; defaults to 5000, or 8000 with an action. */
	duration?: number;
	/** Fires once, however the toast went away. */
	onclose?: (reason: ToastCloseReason) => void;
}

export interface ToastItem {
	id: number;
	message: string;
	action: ToastAction | null;
	tone: ToastTone;
}

interface Timing {
	remaining: number;
	startedAt: number;
	handle: number | undefined;
	pauses: number;
	onclose: ((reason: ToastCloseReason) => void) | undefined;
}

const MAX_VISIBLE = 3;
let nextId = 1;
const timings = new Map<number, Timing>();

export const toasts: ToastItem[] = $state([]);

export function toast(input: ToastOptions | string): number {
	const opts = typeof input === "string" ? { message: input } : input;
	const id = nextId++;
	toasts.push({ id, message: opts.message, action: opts.action ?? null, tone: opts.tone ?? "neutral" });
	timings.set(id, {
		remaining: opts.duration ?? (opts.action ? 8000 : 5000),
		startedAt: 0,
		handle: undefined,
		pauses: 0,
		onclose: opts.onclose,
	});
	start(id);
	while (toasts.length > MAX_VISIBLE) {
		const oldest = toasts[0];
		if (!oldest) break;
		closeToast(oldest.id, "evicted");
	}
	return id;
}

function start(id: number): void {
	const t = timings.get(id);
	if (!t) return;
	t.startedAt = performance.now();
	t.handle = window.setTimeout(() => closeToast(id, "timeout"), t.remaining);
}

export function closeToast(id: number, reason: ToastCloseReason = "dismiss"): void {
	const t = timings.get(id);
	if (!t) return;
	clearTimeout(t.handle);
	timings.delete(id);
	const i = toasts.findIndex((item) => item.id === id);
	if (i >= 0) toasts.splice(i, 1);
	t.onclose?.(reason);
}

export function runToastAction(id: number): void {
	const item = toasts.find((t) => t.id === id);
	if (!item?.action) return;
	const { run } = item.action;
	closeToast(id, "action");
	run();
}

/** Pointer hover and keyboard focus each hold a pause; the timer resumes when both are released. */
export function pauseToast(id: number): void {
	const t = timings.get(id);
	if (!t) return;
	t.pauses += 1;
	if (t.pauses > 1) return;
	clearTimeout(t.handle);
	t.remaining = Math.max(0, t.remaining - (performance.now() - t.startedAt));
}

export function resumeToast(id: number): void {
	const t = timings.get(id);
	if (!t || t.pauses === 0) return;
	t.pauses -= 1;
	if (t.pauses === 0) start(id);
}
