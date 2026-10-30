<script lang="ts">
	import type { Snippet } from "svelte";
	import type { IconComponent } from "../icons";
	import Icon from "./Icon.svelte";

	interface Props {
		tone?: "info" | "warning" | "danger" | "neutral";
		icon?: IconComponent;
		text?: string;
		children?: Snippet;
		actions?: Snippet;
	}

	let { tone = "neutral", icon, text, children, actions }: Props = $props();
</script>

<div class="banner" data-tone={tone} role={tone === "danger" ? "alert" : "status"}>
	<div class="text">
		{#if icon}<Icon {icon} size="sm" />{/if}
		<span>{text}{@render children?.()}</span>
	</div>
	{#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
	.banner {
		--tone: var(--fg-subtle);
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--sp-2) var(--sp-3);
		padding: var(--sp-2) var(--sp-3);
		background: var(--surface-2);
		border-block-end: var(--border);
		border-inline-start: var(--edge-w) solid var(--tone);
		font-size: var(--text-sm);
		z-index: var(--z-banner);
		flex: none;
		&[data-tone="info"] {
			--tone: var(--info);
		}
		&[data-tone="warning"] {
			--tone: var(--warning);
		}
		&[data-tone="danger"] {
			--tone: var(--danger);
		}
	}
	.text {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-width: 0;
		:global(.icon) {
			color: var(--tone);
		}
	}
	.actions {
		display: flex;
		gap: var(--sp-2);
		margin-inline-start: auto;
	}
</style>
