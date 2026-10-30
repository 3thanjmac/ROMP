<script lang="ts">
	interface Props {
		/** lines: text/terminal lines · rows: list rows (icon + name + meta) · blocks: chat transcript */
		preset: "lines" | "rows" | "blocks";
		count?: number;
		/** lines only: monospace line height, plus a line-number gutter column. */
		mono?: boolean;
		gutter?: boolean;
		/** Extra text under the skeleton (e.g. "Connecting to terminal…"). */
		note?: string | null;
	}

	let { preset, count, mono = false, gutter = false, note = null }: Props = $props();

	const n = $derived(count ?? (preset === "rows" ? 8 : preset === "blocks" ? 3 : 3));
	// Varying widths read as text instead of a striped block.
	const widths = [92, 76, 84, 58, 88, 70, 64, 80];
</script>

<div class="skel" data-preset={preset} class:mono aria-busy="true" aria-label="Loading">
	{#if preset === "lines"}
		{#each { length: n }, i}
			<div class="line">
				{#if gutter}<span class="skeleton gutter"></span>{/if}
				<span class="skeleton bar" style:width="{widths[i % widths.length]}%"></span>
			</div>
		{/each}
	{:else if preset === "rows"}
		{#each { length: n }, i}
			<div class="row">
				<span class="skeleton glyph"></span>
				<span class="skeleton bar" style:width="{(widths[i % widths.length] ?? 80) / 2}%"></span>
				<span class="skeleton meta"></span>
			</div>
		{/each}
	{:else}
		{#each { length: n }, i}
			<div class="block" class:mine={i === 0}><span class="skeleton"></span></div>
		{/each}
	{/if}
	{#if note}<p class="muted note">{note}</p>{/if}
</div>

<style>
	.skel {
		display: grid;
		gap: var(--sp-2);
		padding: var(--sp-3);
		align-content: start;
	}
	.line {
		display: flex;
		gap: var(--sp-3);
		height: 1lh;
		align-items: center;
		.bar {
			height: 0.75lh;
		}
		.gutter {
			width: 2ch;
			height: 0.75lh;
			flex: none;
		}
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		gap: var(--sp-1);
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		height: var(--row-h);
		.glyph {
			width: var(--icon-md);
			height: var(--icon-md);
			flex: none;
		}
		.bar {
			height: 0.75lh;
		}
		.meta {
			width: 3rem;
			height: 0.6lh;
			margin-inline-start: auto;
		}
	}
	[data-preset="blocks"] {
		gap: var(--sp-4);
		padding: var(--sp-4);
	}
	.block {
		span {
			display: block;
			height: 4lh;
			border-radius: var(--radius-lg);
		}
		&.mine {
			justify-self: end;
			width: 60%;
			span {
				height: 2lh;
			}
		}
	}
	.note {
		margin-top: var(--sp-2);
		font-size: var(--text-sm);
	}
</style>
