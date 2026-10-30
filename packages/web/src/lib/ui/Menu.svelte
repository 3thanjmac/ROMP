<script module lang="ts">
	import type { Placement } from "./floating";

	/** Spread these onto the trigger button (`{...props}`); they wire opening, ARIA state and the anchor ref. */
	export interface MenuTriggerProps {
		"aria-haspopup": "menu";
		"aria-expanded": boolean;
		onpointerdown: (e: PointerEvent) => void;
		onclick: (e: MouseEvent) => void;
		onkeydown: (e: KeyboardEvent) => void;
		[ref: symbol]: (node: HTMLElement) => () => void;
	}

	export interface MenuContext {
		close(returnFocus: boolean): void;
	}

	export const MENU_CONTEXT = Symbol("menu");
	export type { Placement };
</script>

<script lang="ts">
	import { setContext, tick, type Snippet } from "svelte";
	import { createAttachmentKey } from "svelte/attachments";
	import Popover from "./Popover.svelte";

	interface Props {
		/** Accessible name of the menu. */
		label: string;
		placement?: Placement;
		trigger: Snippet<[MenuTriggerProps]>;
		/** MenuItem / MenuSection children. */
		children: Snippet;
		onopenchange?: (open: boolean) => void;
	}

	let { label, placement = "bottom-start", trigger, children, onopenchange }: Props = $props();

	let open = $state(false);
	let anchor = $state<HTMLElement | null>(null);
	let panel = $state<HTMLElement | null>(null);
	let lastPointer = "";

	const ITEM = '[role^="menuitem"]:not([disabled])';

	async function show(focus: "first" | "last" | "panel") {
		open = true;
		onopenchange?.(true);
		await tick();
		const items = panel?.querySelectorAll<HTMLElement>(ITEM);
		if (focus === "first") items?.[0]?.focus();
		else if (focus === "last") items?.[items.length - 1]?.focus();
		else panel?.focus({ preventScroll: true });
	}

	function hide(returnFocus: boolean) {
		if (!open) return;
		open = false;
		onopenchange?.(false);
		if (returnFocus) anchor?.focus({ preventScroll: true });
	}

	setContext<MenuContext>(MENU_CONTEXT, { close: hide });

	// Mouse and pen open on press so press-drag-release picks an item in one motion; touch opens on click so a
	// scroll gesture that starts on a trigger never pops a menu.
	function onpointerdown(e: PointerEvent) {
		lastPointer = e.pointerType;
		if (e.button !== 0 || e.pointerType === "touch") return;
		if (open) {
			hide(false);
			return;
		}
		void show("panel");
		const pick = (up: PointerEvent) => {
			window.removeEventListener("pointerup", pick, true);
			const item = (up.target as Element | null)?.closest?.<HTMLElement>(ITEM);
			if (item && panel?.contains(item)) item.click();
		};
		window.addEventListener("pointerup", pick, true);
	}

	function onclick(e: MouseEvent) {
		const keyboard = e.detail === 0;
		if (!keyboard && lastPointer !== "touch") return;
		if (open) hide(keyboard);
		else void show(keyboard ? "first" : "panel");
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		e.preventDefault();
		void show(e.key === "ArrowDown" ? "first" : "last");
	}

	function onPanelKey(e: KeyboardEvent) {
		if (!panel) return;
		if (e.key === "Tab") {
			hide(false);
			return;
		}
		const items = [...panel.querySelectorAll<HTMLElement>(ITEM)];
		if (items.length === 0) return;
		const i = items.indexOf(document.activeElement as HTMLElement);
		let next = -1;
		if (e.key === "ArrowDown") next = (i + 1) % items.length;
		else if (e.key === "ArrowUp") next = i <= 0 ? items.length - 1 : i - 1;
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = items.length - 1;
		if (next < 0) return;
		e.preventDefault();
		items[next]?.focus();
	}

	const refKey = createAttachmentKey();
	function ref(node: HTMLElement) {
		anchor = node;
		return () => {
			if (anchor === node) anchor = null;
		};
	}

	const triggerProps: MenuTriggerProps = $derived({
		"aria-haspopup": "menu",
		"aria-expanded": open,
		onpointerdown,
		onclick,
		onkeydown,
		[refKey]: ref,
	});
</script>

{@render trigger(triggerProps)}
<Popover
	{anchor}
	{open}
	{placement}
	role="menu"
	{label}
	bind:panel
	onkeydown={onPanelKey}
	ondismiss={(how) => hide(how === "escape")}
>
	{@render children()}
</Popover>
