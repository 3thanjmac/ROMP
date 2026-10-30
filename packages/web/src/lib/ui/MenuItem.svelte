<script lang="ts">
	import { getContext, type Snippet } from "svelte";
	import { Icons, type IconComponent } from "../icons";
	import Icon from "./Icon.svelte";
	import { MENU_CONTEXT, type MenuContext } from "./Menu.svelte";

	interface Props {
		icon?: IconComponent;
		danger?: boolean;
		disabled?: boolean;
		/** Set for radio-like items (current workspace, current width); shows a check when true. */
		checked?: boolean;
		/** Runs after the menu closes (so a dialog it opens takes focus). */
		onselect: () => void;
		/** Right-aligned extra content (count, shortcut). */
		trailing?: Snippet;
		children: Snippet;
	}

	let { icon, danger = false, disabled = false, checked, onselect, trailing, children }: Props = $props();

	const menu = getContext<MenuContext>(MENU_CONTEXT);

	function onclick() {
		menu.close(true);
		onselect();
	}

	function onpointermove(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		if (e.pointerType !== "touch" && document.activeElement !== el) el.focus({ preventScroll: true });
	}
</script>

<button
	role={checked === undefined ? "menuitem" : "menuitemradio"}
	aria-checked={checked}
	tabindex="-1"
	class="item"
	class:danger
	{disabled}
	{onclick}
	{onpointermove}
>
	{#if icon}<Icon {icon} />{/if}
	<span class="label truncate">{@render children()}</span>
	{#if trailing}<span class="trailing meta tabular">{@render trailing()}</span>{/if}
	{#if checked}<span class="check"><Icon icon={Icons.Check} size="sm" /></span>{/if}
</button>

<style>
	.item {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		width: 100%;
		min-height: var(--row-h);
		padding: 0 var(--sp-2);
		border-radius: var(--radius-sm);
		color: var(--fg);
		text-align: start;
		transition: background var(--dur-fast);
		:global(.icon) {
			color: var(--fg-muted);
		}
		&:hover:not([disabled]),
		&:focus-visible,
		&:focus {
			background: var(--surface-3);
			outline: none;
		}
		&:active:not([disabled]) {
			background: oklch(from var(--surface-3) calc(l + var(--active-l)) c h);
		}
		&[disabled] {
			opacity: 0.6;
			cursor: not-allowed;
		}
		&.danger,
		&.danger :global(.icon) {
			color: var(--danger);
		}
	}
	.label {
		flex: 1;
	}
	.trailing {
		margin-inline-start: auto;
		padding-inline-start: var(--sp-3);
	}
	.check {
		color: var(--accent);
		display: inline-flex;
	}
</style>
