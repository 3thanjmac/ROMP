<script lang="ts">
	import { formatDuration } from "../../lib/agent/format";
	import { toolArgsText, toolKind, toolOutputText, toolSummary, type ToolKind } from "../../lib/agent/tools";
	import type { ToolBlock, ToolRun, ToolStatus } from "../../lib/agent/types";
	import { Icons, type IconComponent } from "../../lib/icons";
	import Button from "../../lib/ui/Button.svelte";
	import Icon from "../../lib/ui/Icon.svelte";
	import Spinner from "../../lib/ui/Spinner.svelte";
	import DiffView from "./DiffView.svelte";

	interface Props {
		block: ToolBlock;
		run: ToolRun | undefined;
		/** The agent is mid-run, so a call without a run yet is about to execute. */
		pending: boolean;
	}

	let { block, run, pending }: Props = $props();

	const KIND_ICON: Record<ToolKind, IconComponent> = {
		bash: Icons.Terminal,
		edit: Icons.ToolEdit,
		read: Icons.ToolRead,
		write: Icons.ToolWrite,
		search: Icons.ToolSearch,
		other: Icons.Tool,
	};
	const CLIP_LINES = 20;

	const status: ToolStatus = $derived(run?.status ?? (pending ? "running" : "interrupted"));
	let toggled = $state<boolean | null>(null);
	/** Collapsed by default; failures open themselves until the user decides. */
	const open = $derived(toggled ?? status === "error");
	let full = $state(false);

	const summary = $derived(toolSummary(block));
	const diffs = $derived(run?.diffs ?? null);
	const argsText = $derived(open && !(block.name === "edit" && diffs) ? toolArgsText(block) : "");
	const output = $derived(run ? toolOutputText(block.name, run) : "");
	/** Edits show their diff; the success text is the edited excerpt again. */
	const showOutput = $derived(open && output.trim() !== "" && !(block.name === "edit" && diffs && status !== "error"));
	const lineCount = $derived(showOutput ? output.trimEnd().split("\n").length : 0);
	const tail = $derived.by(() => {
		if (open || status !== "running" || !output) return "";
		const text = output.trimEnd();
		let cut = text.length;
		for (let n = 0; n < 3 && cut > 0; n++) cut = text.lastIndexOf("\n", cut - 1);
		return text.slice(cut + 1);
	});

	function toggle() {
		toggled = !open;
	}
</script>

<div class="tool" data-status={status}>
	<button type="button" class="head" aria-expanded={open} onclick={toggle}>
		<Icon icon={KIND_ICON[toolKind(block.name)]} size="sm" />
		<span class="name mono">{block.name}</span>
		<span class="summary truncate">{summary}</span>
		<span class="end">
			{#if status === "running"}
				<Spinner size="sm" label="Running" />
			{:else if status === "done"}
				<span class="ok"><Icon icon={Icons.Check} size="sm" label="Done" /></span>
			{:else if status === "error"}
				<span class="fail"><Icon icon={Icons.Fail} size="sm" label="Failed" /></span>
			{:else}
				<span class="stopped"><Icon icon={Icons.Stop} size="xs" label="Interrupted" /></span>
			{/if}
			{#if run?.durationMs != null && status !== "running"}
				<span class="meta tabular">{formatDuration(run.durationMs)}</span>
			{/if}
			<span class="chev"><Icon icon={Icons.ChevronRight} size="sm" /></span>
		</span>
	</button>
	{#if open}
		<div class="body">
			{#if argsText}<pre class="well">{argsText}</pre>{/if}
			{#if diffs}<DiffView {diffs} showPaths={diffs.length > 1} />{/if}
			{#if showOutput}
				<pre class="well output" class:full>{output}</pre>
				{#if lineCount > CLIP_LINES && !full}
					<div class="more">
						<Button variant="ghost" size="sm" onclick={() => (full = true)}>Show all {lineCount} lines</Button>
					</div>
				{/if}
			{/if}
			{#each run?.images ?? [] as src, i (i)}
				<img {src} alt="Output of {block.name}" />
			{/each}
			{#if status === "interrupted"}<p class="meta">Interrupted before it finished.</p>{/if}
		</div>
	{:else if tail}
		<pre class="tail" aria-hidden="true">{tail}</pre>
	{/if}
</div>

<style>
	.tool {
		background: var(--surface-2);
		border: var(--border);
		border-radius: var(--radius-md);
		min-width: 0;
	}
	.head {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		width: 100%;
		min-height: var(--row-h);
		padding-inline: var(--sp-3) var(--sp-2);
		border-radius: var(--radius-md);
		font-size: var(--text-sm);
		color: var(--fg);
		transition: background var(--dur-fast);
		&:hover {
			background: var(--surface-3);
		}
		> :global(.icon) {
			color: var(--fg-muted);
		}
	}
	.name {
		font-weight: 600;
		flex: none;
	}
	.summary {
		flex: 1;
		color: var(--fg-muted);
		font-family: var(--font-mono);
		font-size: var(--text-xs);
	}
	.end {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		flex: none;
	}
	.ok {
		display: inline-flex;
		color: var(--success);
	}
	.fail {
		display: inline-flex;
		color: var(--danger);
	}
	.stopped {
		display: inline-flex;
		color: var(--fg-subtle);
	}
	.chev {
		display: inline-flex;
		color: var(--fg-subtle);
		transition: rotate var(--dur);
	}
	[aria-expanded="true"] .chev {
		rotate: 90deg;
	}
	.body {
		display: grid;
		gap: var(--sp-2);
		padding: 0 var(--sp-2) var(--sp-2);
		min-width: 0;
	}
	.well,
	.tail {
		margin: 0;
		padding: var(--sp-2);
		background: var(--inset);
		border-radius: var(--radius-sm);
		font-size: var(--text-xs);
		line-height: 1.5;
		white-space: pre;
		overflow: auto;
	}
	.well {
		max-height: calc(20lh + var(--sp-2) * 2);
		&.full {
			max-height: none;
		}
	}
	.tail {
		margin: 0 var(--sp-2) var(--sp-2);
		max-height: calc(3lh + var(--sp-2) * 2);
		overflow: hidden;
		color: var(--fg-muted);
	}
	.more {
		display: flex;
		justify-content: flex-start;
	}
	img {
		max-width: 100%;
		border-radius: var(--radius-sm);
	}
</style>
