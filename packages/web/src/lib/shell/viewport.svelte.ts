/**
 * Viewport facts the shell lays out by. The visual viewport sets --vvh / --vv-top / --kb-inset on <html> so the
 * app root always fits above the on-screen keyboard. On iOS, focusing a text field also never scrolls the page.
 */

export type Layout = "phone" | "tablet" | "desktop";

/** Keyboard heights below this are browser chrome (URL bar) changes, not a keyboard. */
const KEYBOARD_MIN_PX = 80;
/** With `interactive-widget=resizes-content` the layout viewport shrinks too; compare against the tallest seen. */
const RESIZED_KEYBOARD_MIN_PX = 150;
/** Longest an iOS keyboard takes to resize the visual viewport after focus; past this, reveal the field anyway. */
const KEYBOARD_SETTLE_MS = 600;
/** A touch that moves further or lasts longer than this is a drag or long press, not a tap to focus. */
const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 500;
/** Space kept between a revealed field and the edge of its scroll container. */
const REVEAL_MARGIN_PX = 12;

class Viewport {
	layout: Layout = $state("desktop");
	/** Primary pointer is coarse (touch). */
	coarse = $state(false);
	keyboardOpen = $state(false);
	reducedMotion = $state(false);
	dark = $state(true);
}

export const viewport = new Viewport();

/** iPhone / iPod Safari (including home-screen apps): components that imitate native iOS controls switch on this. */
export const IPHONE = /iPhone|iPod/.test(navigator.userAgent);
/** iOS / iPadOS WebKit. iPadOS Safari reports itself as a Mac; the touch points give it away. */
const IOS = IPHONE || /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

function watch(query: string, apply: (matches: boolean) => void): void {
	const mql = matchMedia(query);
	apply(mql.matches);
	mql.addEventListener("change", (e) => apply(e.matches));
}

const TEXT_INPUT = /^(text|search|email|url|tel|password|number)$/;

/** Whether focusing `el` brings up the on-screen keyboard. */
function opensKeyboard(el: Element | null): el is HTMLElement {
	if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
	if (el instanceof HTMLInputElement) return TEXT_INPUT.test(el.type) && !el.disabled && !el.readOnly;
	return el instanceof HTMLElement && el.isContentEditable;
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

let revealing: HTMLElement | null = null;
let revealTimer = 0;

/** Scrolls `el` (or its caret, in an editable region) into view within its scroll containers, never the page. */
function reveal(): void {
	const el = revealing;
	revealing = null;
	clearTimeout(revealTimer);
	if (!el || document.activeElement !== el) return;
	let { top, bottom } = el.getBoundingClientRect();
	const selection = el.isContentEditable ? getSelection() : null;
	if (selection?.rangeCount && el.contains(selection.anchorNode)) {
		const caret = selection.getRangeAt(0).getBoundingClientRect();
		if (caret.height) ({ top, bottom } = caret);
	}
	for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
		if (!SCROLLS.test(getComputedStyle(p).overflowY) || p.scrollHeight <= p.clientHeight) continue;
		const boxTop = p.getBoundingClientRect().top + p.clientTop;
		const boxBottom = boxTop + p.clientHeight;
		let delta = 0;
		if (bottom > boxBottom) delta = bottom - boxBottom + REVEAL_MARGIN_PX;
		// A field taller than the container keeps its top in view.
		if (top - delta < boxTop) delta = top - boxTop - REVEAL_MARGIN_PX;
		if (!delta) continue;
		const before = p.scrollTop;
		p.scrollTop += delta;
		const moved = p.scrollTop - before;
		top -= moved;
		bottom -= moved;
	}
}

/** Reveals `el` once the keyboard has resized the frame (right away if it is already up). */
function revealWhenSettled(el: HTMLElement): void {
	revealing = el;
	clearTimeout(revealTimer);
	revealTimer = window.setTimeout(reveal, viewport.keyboardOpen ? 0 : KEYBOARD_SETTLE_MS);
}

/**
 * iOS scrolls the page to centre a text field as it gains focus, even a field that is already in view. The frame
 * follows the visual viewport, so it first slides with that scroll and then snaps back on the next viewport event:
 * the visible jump when the keyboard opens. Every focus that opens the keyboard is made with `preventScroll`
 * instead: programmatic ones by wrapping `focus()`, taps by cancelling the touchend and focusing the field
 * ourselves. Once the keyboard has shrunk the frame, the field is scrolled into view within its own containers.
 * Taps on the already-focused field stay native, so caret placement and selection work as usual.
 */
function preventFocusScroll(): void {
	const focus = HTMLElement.prototype.focus;
	HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
		if (options?.preventScroll || !opensKeyboard(this)) return focus.call(this, options);
		focus.call(this, { ...options, preventScroll: true });
		if (document.activeElement === this) revealWhenSettled(this);
	};

	let tap: { x: number; y: number; t: number } | null = null;
	document.addEventListener(
		"touchstart",
		(e) => {
			const t = e.touches[0];
			tap = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY, t: e.timeStamp } : null;
		},
		{ passive: true, capture: true },
	);
	document.addEventListener(
		"touchend",
		(e) => {
			const t = e.changedTouches[0];
			const start = tap;
			tap = null;
			if (!e.cancelable || !start || !t || e.touches.length > 0) return;
			if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > TAP_SLOP_PX) return;
			if (e.timeStamp - start.t > TAP_MAX_MS) return;
			const field = e.target instanceof Element ? e.target.closest("input, textarea, [contenteditable]") : null;
			if (!opensKeyboard(field) || field.contains(document.activeElement)) return;
			e.preventDefault();
			field.focus();
		},
		{ passive: false, capture: true },
	);
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
	if (IOS) preventFocusScroll();

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
			inset > KEYBOARD_MIN_PX || (tallest - height > RESIZED_KEYBOARD_MIN_PX && opensKeyboard(document.activeElement));
		// Wait a frame so the keyboard-dependent UI (bottom bar) has updated before measuring.
		if (revealing && viewport.keyboardOpen) {
			clearTimeout(revealTimer);
			requestAnimationFrame(reveal);
		}
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
