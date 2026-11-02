<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLButtonAttributes } from "svelte/elements";
	import { Icons, type IconComponent } from "../icons";
	import type { ButtonSize, ButtonVariant } from "./Button.svelte";
	import Icon from "./Icon.svelte";
	import { tooltip } from "./tooltip";

	interface Props extends HTMLButtonAttributes {
		/** Runs on click; the button disables itself and shows a spinner until it settles. Errors propagate. */
		action?: () => Promise<unknown>;
		/** Pending state; bind it, or drive it from a form submit handler (type="submit" without `action`). */
		pending?: boolean;
		/** Label shown while pending; may change over time (e.g. stepping progress text). */
		pendingLabel?: string;
		variant?: ButtonVariant;
		size?: ButtonSize;
		icon?: IconComponent;
		/** Unavailable but focusable (aria-disabled), with the reason as a tooltip; clicks are swallowed. */
		disabledReason?: string | null;
		children?: Snippet;
	}

	let {
		action,
		pending = $bindable(false),
		pendingLabel,
		variant = "primary",
		size = "md",
		icon,
		disabledReason = null,
		children,
		disabled,
		type = "button",
		...rest
	}: Props = $props();

	async function run(e: MouseEvent) {
		if (disabledReason) {
			e.preventDefault();
			return;
		}
		if (!action || pending) return;
		pending = true;
		try {
			await action();
		} finally {
			pending = false;
		}
	}
</script>

<button
	{...rest}
	{type}
	data-variant={variant}
	data-size={size}
	disabled={disabled || pending}
	aria-busy={pending}
	aria-disabled={disabledReason ? "true" : rest["aria-disabled"]}
	data-unavailable={disabledReason ? "" : undefined}
	onclick={action || disabledReason ? run : rest.onclick}
	use:tooltip={disabledReason ?? undefined}
>
	{#if pending}
		<Icon icon={Icons.Spinner} size={size === "sm" ? "sm" : "md"} spin />
	{:else if icon}
		<Icon {icon} size={size === "sm" ? "sm" : "md"} />
	{/if}
	{#if pending && pendingLabel}{pendingLabel}{:else}{@render children?.()}{/if}
</button>

<style>
	[data-unavailable] {
		opacity: 0.6;
		cursor: not-allowed;
	}
</style>
