<script lang="ts">
	import type { Snippet } from "svelte";
	import type { IconComponent } from "../icons";
	import Icon from "./Icon.svelte";

	interface Props {
		icon?: IconComponent;
		title: string;
		text?: string | null;
		children?: Snippet;
		actions?: Snippet;
	}

	let { icon, title, text, children, actions }: Props = $props();
</script>

<div class="empty">
	{#if icon}<span class="glyph"><Icon {icon} size="xl" /></span>{/if}
	<h3>{title}</h3>
	{#if text}<p class="muted">{text}</p>{/if}
	{@render children?.()}
	{#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		/* safe: in a short pane the content scrolls instead of overflowing above the top edge. */
		justify-content: safe center;
		gap: var(--sp-2);
		padding: var(--sp-8) var(--sp-4);
		text-align: center;
		min-height: 100%;
		margin-inline: auto;
		max-width: var(--dialog-w);
	}
	.glyph {
		color: var(--fg-subtle);
		margin-bottom: var(--sp-1);
	}
	p {
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: var(--sp-2);
		margin-top: var(--sp-2);
	}
</style>
