<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLButtonAttributes } from "svelte/elements";
	import { Icons, type IconComponent } from "../icons";
	import type { ButtonSize, ButtonVariant } from "./Button.svelte";
	import Icon from "./Icon.svelte";

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
		children?: Snippet;
	}

	let {
		action,
		pending = $bindable(false),
		pendingLabel,
		variant = "primary",
		size = "md",
		icon,
		children,
		disabled,
		type = "button",
		...rest
	}: Props = $props();

	async function run() {
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
	onclick={action ? run : rest.onclick}
>
	{#if pending}
		<Icon icon={Icons.Spinner} size={size === "sm" ? "sm" : "md"} spin />
	{:else if icon}
		<Icon {icon} size={size === "sm" ? "sm" : "md"} />
	{/if}
	{#if pending && pendingLabel}{pendingLabel}{:else}{@render children?.()}{/if}
</button>
