<script module lang="ts">
	export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
	export type ButtonSize = "sm" | "md";
</script>

<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLButtonAttributes } from "svelte/elements";
	import type { IconComponent } from "../icons";
	import Icon from "./Icon.svelte";
	import { tooltip } from "./tooltip";

	interface Props extends HTMLButtonAttributes {
		variant?: ButtonVariant;
		size?: ButtonSize;
		icon?: IconComponent;
		iconEnd?: IconComponent;
		/**
		 * Renders the button as unavailable (aria-disabled) while keeping it hoverable and focusable, so the
		 * reason shows as a tooltip. Clicks are swallowed.
		 */
		disabledReason?: string | null;
		children?: Snippet;
	}

	let {
		variant = "secondary",
		size = "md",
		icon,
		iconEnd,
		disabledReason = null,
		children,
		type = "button",
		onclick,
		...rest
	}: Props = $props();

	function click(e: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }) {
		if (disabledReason) {
			e.preventDefault();
			return;
		}
		onclick?.(e);
	}
</script>

<button
	{...rest}
	{type}
	data-variant={variant}
	data-size={size}
	aria-disabled={disabledReason ? "true" : rest["aria-disabled"]}
	data-unavailable={disabledReason ? "" : undefined}
	onclick={click}
	use:tooltip={disabledReason ?? undefined}
>
	{#if icon}<Icon {icon} size={size === "sm" ? "sm" : "md"} />{/if}
	{@render children?.()}
	{#if iconEnd}<Icon icon={iconEnd} size="sm" />{/if}
</button>

<style>
	[data-unavailable] {
		opacity: 0.6;
		cursor: not-allowed;
	}
</style>
