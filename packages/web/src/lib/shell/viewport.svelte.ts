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

const SCROLLS = /^(auto|scroll|overlay)$/;

/** Whether a touch moving by (dx, dy) scrolls an element between `target` and the body (along its main axis). */
function scrollsInside(target: EventTarget | null, dx: number, dy: number): boolean {
	const vertical = Math.abs(dy) >= Math.abs(dx);
	for (let el = target instanceof Element ? target : null; el && el !== document.body; el = el.parentElement) {
		const style = getComputedStyle(el);
		if (vertical) {
			if (!SCROLLS.test(style.overflowY) || el.scrollHeight <= el.clientHeight) continue;
			if (dy > 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
		} else {
			if (!SCROLLS.test(style.overflowX) || el.scrollWidth <= el.clientWidth) continue;
			if (dx > 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
		}
	}
	return false;
}

/**
 * The app never zooms, and the page itself never scrolls. html/body don't overflow, but with the iOS keyboard up
 * the visual viewport can still be dragged around the layout viewport, shifting the whole UI. A one-finger drag
 * that no element inside would scroll is cancelled; drags in the focused text field (caret, selection) pass.
 */
function lockPageGestures(): void {
	let x0 = 0;
	let y0 = 0;
	/** For the current one-finger gesture: null until it moves, then whether the browser may scroll. */
	let native: boolean | null = null;
	document.addEventListener(
		"touchstart",
		(e) => {
			const t = e.touches[0];
			if (e.touches.length !== 1 || !t) return;
			x0 = t.clientX;
			y0 = t.clientY;
			native = null;
		},
		{ passive: true },
	);
	document.addEventListener(
		"touchmove",
		(e) => {
			if (!e.cancelable) return;
			if (e.touches.length > 1) {
				e.preventDefault();
				return;
			}
			const t = e.touches[0];
			if (!viewport.keyboardOpen || !t) return;
			if (native === null) {
				const dx = t.clientX - x0;
				const dy = t.clientY - y0;
				if (dx === 0 && dy === 0) return;
				native = e.target === document.activeElement || scrollsInside(e.target, dx, dy);
			}
			if (!native) e.preventDefault();
		},
		{ passive: false },
	);
	// Safari ignores user-scalable=no for pinch zoom; its gesture events still cancel it.
	document.addEventListener("gesturestart", (e) => e.preventDefault());
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
	lockPageGestures();

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
