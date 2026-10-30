<script lang="ts">
	import type { HTMLButtonAttributes } from "svelte/elements";
	import type { IconComponent } from "../icons";
	import type { ButtonVariant } from "./Button.svelte";
	import Icon, { type IconSize } from "./Icon.svelte";
	import { tooltip } from "./tooltip";

	interface Props extends HTMLButtonAttributes {
		/** Required: becomes aria-label and the visible tooltip. */
		label: string;
		icon: IconComponent;
		variant?: ButtonVariant;
		/** sm: inside rows · md: standalone · bar: fills a title bar / toolbar row (--tap on coarse pointers). */
		size?: "sm" | "md" | "bar";
		iconSize?: IconSize;
		pressed?: boolean;
		spin?: boolean;
	}

	let {
		label,
		icon,
		variant = "ghost",
		size = "md",
		iconSize = "md",
		pressed,
		spin = false,
		type = "button",
		...rest
	}: Props = $props();
</script>

<button
	{...rest}
	{type}
	class="icon-btn"
	data-variant={variant}
	data-size={size}
	aria-label={label}
	aria-pressed={pressed}
	use:tooltip
>
	<Icon {icon} size={iconSize} {spin} />
</button>

<style>
	.icon-btn {
		--ib: calc(1lh + var(--sp-2) * 2 + 2px);
		width: var(--ib);
		height: var(--ib);
		min-height: var(--ib);
		padding: 0;
		flex: none;
		&[data-size="sm"] {
			--ib: calc(1lh + var(--sp-1) * 2 + 2px);
		}
		&[data-size="bar"] {
			--ib: var(--titlebar-h);
			border-radius: var(--radius-sm);
		}
	}
	@media (pointer: coarse) {
		.icon-btn,
		.icon-btn[data-size="sm"],
		.icon-btn[data-size="bar"] {
			--ib: var(--tap);
		}
	}
</style>
