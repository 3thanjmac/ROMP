<script lang="ts">
	import type { AssistantItem, Block, ToolBlock, ToolRun } from "../../lib/agent/types";
	import Markdown from "./Markdown.svelte";
	import ThinkingBlock from "./ThinkingBlock.svelte";
	import ToolCard from "./ToolCard.svelte";

	interface Props {
		item: AssistantItem;
		tools: Record<string, ToolRun>;
		/** A run is in flight, so tool calls without a result yet are about to execute. */
		busy: boolean;
	}

	let { item, tools, busy }: Props = $props();

	type Segment = { kind: "block"; index: number; block: Exclude<Block, ToolBlock> } | { kind: "tools"; index: number; calls: ToolBlock[] };

	/** Consecutive tool calls share one tight group. */
	const segments = $derived.by(() => {
		const out: Segment[] = [];
		item.blocks.forEach((block, index) => {
			if (!block) return;
			if (block.type !== "tool") {
				out.push({ kind: "block", index, block });
				return;
			}
			const last = out.at(-1);
			if (last?.kind === "tools") last.calls.push(block);
			else out.push({ kind: "tools", index, calls: [block] });
		});
		return out;
	});
</script>

<div class="assistant">
	{#each segments as seg (seg.index)}
		{#if seg.kind === "tools"}
			<div class="tools">
				{#each seg.calls as call (call.id)}
					<ToolCard block={call} run={tools[call.id]} pending={busy} />
				{/each}
			</div>
		{:else if seg.block.type === "text"}
			{#if seg.block.text.trim()}
				<Markdown text={seg.block.text} streaming={item.streaming && item.openBlock === seg.index} />
			{/if}
		{:else if seg.block.type === "thinking"}
			<ThinkingBlock block={seg.block} live={item.streaming && item.openBlock === seg.index} />
		{:else}
			<img src={seg.block.src} alt="Output from the agent" />
		{/if}
	{/each}
	{#if item.stopReason === "error"}
		<p class="error">{item.errorMessage ?? "The model request failed."}</p>
	{:else if item.stopReason === "aborted"}
		<p class="meta">Stopped.</p>
	{/if}
</div>

<style>
	.assistant {
		display: grid;
		gap: var(--sp-3);
		min-width: 0;
	}
	.tools {
		display: grid;
		gap: var(--sp-1);
		min-width: 0;
	}
	.error {
		padding: var(--sp-2) var(--sp-3);
		background: var(--danger-soft);
		border-inline-start: var(--edge-w) solid var(--danger);
		border-radius: var(--radius-sm);
		font-size: var(--text-sm);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	img {
		max-width: 100%;
		border-radius: var(--radius-md);
	}
</style>
