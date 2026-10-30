/**
 * The one floating mechanism (menus, popovers, tooltips): panels are native `popover="manual"` elements, so they
 * render in the top layer (escaping overflow clipping and sitting above open dialogs) without moving DOM nodes,
 * and Floating UI places them against their anchor, flipping and clamping to the viewport.
 */
import { autoUpdate, computePosition, flip, offset, type Placement, shift, size } from "@floating-ui/dom";

export type { Placement };

const EDGE_PAD = 8;

/** Keeps `panel` attached to `anchor` (scroll, resize, layout shifts). Returns the cleanup. */
export function place(anchor: Element, panel: HTMLElement, placement: Placement, gap = 4): () => void {
	return autoUpdate(anchor, panel, () => {
		void computePosition(anchor, panel, {
			placement,
			strategy: "fixed",
			middleware: [
				offset(gap),
				flip({ padding: EDGE_PAD }),
				shift({ padding: EDGE_PAD }),
				size({
					padding: EDGE_PAD,
					apply({ availableHeight, elements }) {
						elements.floating.style.setProperty("--available-h", `${Math.max(0, availableHeight)}px`);
					},
				}),
			],
		}).then(({ x, y }) => {
			panel.style.left = `${x}px`;
			panel.style.top = `${y}px`;
		});
	});
}

/** Shows a `popover="manual"` element in the top layer (no-op when it is already showing). */
export function showTop(el: HTMLElement): void {
	if (!el.matches(":popover-open")) el.showPopover();
}

/** Re-shows a top-layer element so it stacks above anything opened since (e.g. a dialog). */
export function raiseTop(el: HTMLElement): void {
	if (el.matches(":popover-open")) el.hidePopover();
	el.showPopover();
}

/**
 * Escape stack: only the most recently opened floating layer handles Escape, and the keydown is cancelled so a
 * native <dialog> underneath does not close as well.
 */
const escapeStack: Array<() => void> = [];
let escapeListening = false;

function onEscape(e: KeyboardEvent): void {
	if (e.key !== "Escape" || escapeStack.length === 0) return;
	e.preventDefault();
	e.stopPropagation();
	escapeStack.at(-1)?.();
}

export function pushEscape(handler: () => void): () => void {
	escapeStack.push(handler);
	if (!escapeListening) {
		document.addEventListener("keydown", onEscape, true);
		escapeListening = true;
	}
	return () => {
		const i = escapeStack.lastIndexOf(handler);
		if (i >= 0) escapeStack.splice(i, 1);
	};
}
