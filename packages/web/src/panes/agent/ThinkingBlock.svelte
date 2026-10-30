<script lang="ts">
	import { formatDuration } from "../../lib/agent/format";
	import type { ThinkingBlock } from "../../lib/agent/types";
	import { Icons } from "../../lib/icons";
	import Button from "../../lib/ui/Button.svelte";

	let { block, live }: { block: ThinkingBlock; live: boolean } = $props();

	let open = $state(false);

	const label = $derived.by(() => {
		if (live) return "Thinking…";
		if (block.startedAt !== null && block.endedAt !== null) return `Thought for ${formatDuration(block.endedAt - block.startedAt)}`;
		return "Thought";
	});
</script>

{#if live || block.text.trim()}
	<div class="thinking">
		<Button variant="ghost" size="sm" icon={Icons.Thinking} iconEnd={Icons.ChevronRight} aria-expanded={open} onclick={() => (open = !open)}>
			{label}
		</Button>
		{#if open}
			<p class="body">{block.text.trim()}</p>
		{:else if live && block.text}
			<p class="body tail" aria-hidden="true">{block.text.trimEnd()}</p>
		{/if}
	</div>
{/if}

<style>
	.thinking {
		display: grid;
		justify-items: start;
		gap: var(--sp-1);
		min-width: 0;
		:global(button .icon:last-child) {
			transition: rotate var(--dur);
		}
		:global(button[aria-expanded="true"] .icon:last-child) {
			rotate: 90deg;
		}
	}
	.body {
		padding-inline-start: var(--sp-2);
		border-inline-start: var(--edge-w) solid var(--line);
		color: var(--fg-subtle);
		font-size: var(--text-sm);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.tail {
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		max-height: 3lh;
		overflow: hidden;
		mask-image: linear-gradient(to bottom, transparent, currentColor 1lh);
	}
</style>
