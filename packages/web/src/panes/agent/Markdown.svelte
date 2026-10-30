<script lang="ts">
	import { markdownBlocks } from "../../lib/agent/markdown";
	import CodeBlock from "./CodeBlock.svelte";

	let { text, streaming = false }: { text: string; streaming?: boolean } = $props();

	const blocks = $derived(markdownBlocks(text, streaming));
</script>

<div class="md">
	{#each blocks as block, i (i)}
		{#if block.kind === "code"}
			<CodeBlock text={block.text} lang={block.lang} />
		{:else}
			<div class="html">{@html block.html}</div>
		{/if}
	{/each}
</div>

<style>
	.md {
		display: grid;
		gap: var(--sp-3);
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.html {
		min-width: 0;
		> :global(* + *) {
			margin-top: var(--sp-3);
		}
		:global(ul),
		:global(ol) {
			padding-inline-start: var(--sp-6);
		}
		:global(li + li),
		:global(li > ul),
		:global(li > ol) {
			margin-top: var(--sp-1);
		}
		:global(code) {
			font-size: 0.9em;
			padding: 0 var(--sp-1);
			background: var(--inset);
			border-radius: var(--radius-sm);
		}
		:global(pre) {
			padding: var(--sp-3);
			overflow-x: auto;
			background: var(--inset);
			border-radius: var(--radius-md);
			font-size: var(--text-sm);
			:global(code) {
				padding: 0;
				background: none;
			}
		}
		:global(blockquote) {
			padding-inline-start: var(--sp-3);
			border-inline-start: var(--edge-w) solid var(--line-strong);
			color: var(--fg-muted);
		}
		:global(table) {
			display: block;
			overflow-x: auto;
			border-collapse: collapse;
			font-size: var(--text-sm);
		}
		:global(th),
		:global(td) {
			padding: var(--sp-1) var(--sp-2);
			border: var(--border);
			text-align: start;
		}
		:global(th) {
			background: var(--surface-2);
		}
		:global(hr) {
			border: 0;
			border-block-start: var(--border);
		}
		:global(img) {
			max-width: 100%;
			border-radius: var(--radius-md);
		}
	}
</style>
