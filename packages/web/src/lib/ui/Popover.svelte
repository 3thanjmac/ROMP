<script lang="ts">
	import type { Snippet } from "svelte";
	import { type Placement, place, pushEscape, showTop } from "./floating";

	interface Props {
		anchor: HTMLElement | null;
		open: boolean;
		placement?: Placement;
		role?: string;
		label?: string;
		/** The user dismissed the panel: a press outside it (or into an iframe), or Escape. */
		ondismiss: (how: "outside" | "escape") => void;
		/** The panel element while open. */
		panel?: HTMLElement | null;
		onkeydown?: (e: KeyboardEvent) => void;
		children: Snippet;
	}

	let {
		anchor,
		open,
		placement = "bottom-start",
		role,
		label,
		ondismiss,
		panel = $bindable(null),
		onkeydown,
		children,
	}: Props = $props();

	function attach(node: HTMLElement) {
		showTop(node);
		const target = anchor;
		const stopPlacing = target ? place(target, node, placement) : null;
		const popEscape = pushEscape(() => ondismiss("escape"));
		const onDown = (e: PointerEvent) => {
			const t = e.target as Node | null;
			if (t && (node.contains(t) || target?.contains(t))) return;
			ondismiss("outside");
		};
		// Presses inside iframes never reach this document; the window loses focus instead.
		const onBlur = () => ondismiss("outside");
		document.addEventListener("pointerdown", onDown, true);
		window.addEventListener("blur", onBlur);
		return () => {
			stopPlacing?.();
			popEscape();
			document.removeEventListener("pointerdown", onDown, true);
			window.removeEventListener("blur", onBlur);
		};
	}
</script>

{#if open && anchor}
	<div
		popover="manual"
		class="popover"
		{role}
		aria-label={label}
		tabindex="-1"
		bind:this={panel}
		{onkeydown}
		{@attach attach}
	>
		{@render children()}
	</div>
{/if}

<style>
	.popover {
		position: fixed;
		inset: auto;
		margin: 0;
		min-width: var(--menu-min-w);
		max-height: min(var(--menu-max-h), var(--available-h, var(--menu-max-h)));
		overflow: auto;
		padding: var(--sp-1);
		color: var(--fg);
		background: var(--surface-2);
		border: var(--border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
		outline: none;
	}
</style>
