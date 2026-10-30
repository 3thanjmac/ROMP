<script lang="ts">
	import type { Snippet } from "svelte";
	import type { IconComponent } from "../icons";
	import Icon from "./Icon.svelte";

	interface Props {
		/** Token name without the leading dashes, e.g. "warning", "task-landing", "fg-muted". */
		tone?: string;
		icon?: IconComponent;
		spin?: boolean;
		children: Snippet;
	}

	let { tone = "fg-muted", icon, spin = false, children }: Props = $props();
</script>

<span class="chip" style:--tone="var(--{tone})">
	{#if icon}<Icon {icon} size="xs" {spin} />{/if}
	{@render children()}
</span>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		height: var(--chip-h);
		padding: 0 var(--sp-2);
		border-radius: var(--radius-full);
		font-size: var(--text-xs);
		font-weight: 500;
		line-height: 1;
		white-space: nowrap;
		color: var(--tone);
		background: oklch(from var(--tone) l c h / 0.16);
		flex: none;
	}
</style>
