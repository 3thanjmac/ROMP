/**
 * `use:tooltip` shows the element's aria-label (or an explicit text) on hover and keyboard focus, never on touch.
 * The first tooltip waits WARMUP_MS; once one has shown, neighbours show instantly within SKIP_MS.
 */
import type { Action } from "svelte/action";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { showTop } from "./floating";

const WARMUP_MS = 600;
const SKIP_MS = 300;

let panel: HTMLDivElement | null = null;
let shown: HTMLElement | null = null;
let pending: HTMLElement | null = null;
let timer: number | undefined;
let lastHiddenAt = Number.NEGATIVE_INFINITY;
let stopTracking: (() => void) | null = null;
const texts = new WeakMap<HTMLElement, string | undefined>();

function ensurePanel(): HTMLDivElement {
	if (panel) return panel;
	panel = document.createElement("div");
	panel.className = "tooltip";
	panel.setAttribute("popover", "manual");
	panel.setAttribute("role", "tooltip");
	document.body.append(panel);
	return panel;
}

function textFor(node: HTMLElement): string | null {
	return texts.get(node) || node.getAttribute("aria-label");
}

function show(node: HTMLElement): void {
	pending = null;
	const text = textFor(node);
	if (!text || !node.isConnected) return;
	const tip = ensurePanel();
	tip.textContent = text;
	showTop(tip);
	shown = node;
	stopTracking?.();
	stopTracking = autoUpdate(node, tip, () => {
		void computePosition(node, tip, {
			placement: "bottom",
			strategy: "fixed",
			middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
		}).then(({ x, y }) => {
			tip.style.left = `${x}px`;
			tip.style.top = `${y}px`;
		});
	});
}

function hide(): void {
	clearTimeout(timer);
	pending = null;
	if (!shown) return;
	shown = null;
	lastHiddenAt = performance.now();
	stopTracking?.();
	stopTracking = null;
	if (panel?.matches(":popover-open")) panel.hidePopover();
}

function schedule(node: HTMLElement): void {
	clearTimeout(timer);
	if (shown === node) return;
	const warm = shown !== null || performance.now() - lastHiddenAt < SKIP_MS;
	if (shown) hide();
	if (warm) {
		show(node);
		return;
	}
	pending = node;
	timer = window.setTimeout(() => show(node), WARMUP_MS);
}

function release(node: HTMLElement): void {
	if (shown === node || pending === node) hide();
}

export const tooltip: Action<HTMLElement, string | undefined> = (node, text) => {
	texts.set(node, text);
	const enter = (e: PointerEvent) => {
		if (e.pointerType !== "touch") schedule(node);
	};
	const leave = () => release(node);
	const focus = () => {
		if (node.matches(":focus-visible")) schedule(node);
	};
	const key = (e: KeyboardEvent) => {
		if (e.key === "Escape") release(node);
	};
	node.addEventListener("pointerenter", enter);
	node.addEventListener("pointerleave", leave);
	node.addEventListener("pointerdown", leave);
	node.addEventListener("focus", focus);
	node.addEventListener("blur", leave);
	node.addEventListener("keydown", key);
	return {
		update(next) {
			texts.set(node, next);
			if (shown === node && panel) {
				const t = textFor(node);
				if (t) panel.textContent = t;
				else hide();
			}
		},
		destroy() {
			node.removeEventListener("pointerenter", enter);
			node.removeEventListener("pointerleave", leave);
			node.removeEventListener("pointerdown", leave);
			node.removeEventListener("focus", focus);
			node.removeEventListener("blur", leave);
			node.removeEventListener("keydown", key);
			release(node);
		},
	};
};
