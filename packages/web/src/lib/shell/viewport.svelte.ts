/**
 * Viewport facts the shell lays out by. The visual viewport sets --vvh / --vv-top / --kb-inset on <html> so the
 * app root always fits above the on-screen keyboard.
 */

export type Layout = "phone" | "tablet" | "desktop";

/** Keyboard heights below this are browser chrome (URL bar) changes, not a keyboard. */
const KEYBOARD_MIN_PX = 80;
/** With `interactive-widget=resizes-content` the layout viewport shrinks too; compare against the tallest seen. */
const RESIZED_KEYBOARD_MIN_PX = 150;

class Viewport {
	layout: Layout = $state("desktop");
	/** Primary pointer is coarse (touch). */
	coarse = $state(false);
	keyboardOpen = $state(false);
	reducedMotion = $state(false);
	dark = $state(true);
}

export const viewport = new Viewport();

function watch(query: string, apply: (matches: boolean) => void): void {
	const mql = matchMedia(query);
	apply(mql.matches);
	mql.addEventListener("change", (e) => apply(e.matches));
}

function editableFocused(): boolean {
	const el = document.activeElement;
	if (!(el instanceof HTMLElement)) return false;
	return el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type !== "button");
}

export function initViewport(): void {
	const phone = matchMedia("(max-width: 639px)");
	const desktop = matchMedia("(min-width: 1024px)");
	const updateLayout = () => {
		viewport.layout = phone.matches ? "phone" : desktop.matches ? "desktop" : "tablet";
	};
	phone.addEventListener("change", updateLayout);
	desktop.addEventListener("change", updateLayout);
	updateLayout();
	watch("(pointer: coarse)", (m) => (viewport.coarse = m));
	watch("(prefers-reduced-motion: reduce)", (m) => (viewport.reducedMotion = m));
	watch("(prefers-color-scheme: dark)", (m) => (viewport.dark = m));

	const vv = window.visualViewport;
	const root = document.documentElement.style;
	let frame = 0;
	let tallest = 0;
	let tallestForWidth = 0;

	const apply = () => {
		frame = 0;
		const height = vv?.height ?? innerHeight;
		const top = vv?.offsetTop ?? 0;
		if (innerWidth !== tallestForWidth) {
			tallestForWidth = innerWidth;
			tallest = 0;
		}
		tallest = Math.max(tallest, innerHeight);
		const inset = Math.max(0, innerHeight - height - top);
		root.setProperty("--vvh", `${height}px`);
		root.setProperty("--vv-top", `${top}px`);
		root.setProperty("--kb-inset", `${inset}px`);
		viewport.keyboardOpen =
			inset > KEYBOARD_MIN_PX || (tallest - height > RESIZED_KEYBOARD_MIN_PX && editableFocused());
	};
	const schedule = () => {
		if (!frame) frame = requestAnimationFrame(apply);
	};
	vv?.addEventListener("resize", schedule);
	vv?.addEventListener("scroll", schedule);
	window.addEventListener("resize", schedule);
	document.addEventListener("focusin", schedule);
	document.addEventListener("focusout", schedule);
	apply();
}
