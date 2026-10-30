<script lang="ts">
	/** Miniature of a column width preset: a box in --line with the share filled in --accent. */
	let { width }: { width: number } = $props();
</script>

<span class="mini" aria-hidden="true"><span class="fill" style:width="{Math.round(width * 100)}%"></span></span>

<style>
	.mini {
		display: inline-flex;
		flex: none;
		width: var(--mini-w);
		height: var(--mini-h);
		padding: var(--radius-xs);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-xs);
	}
	.fill {
		height: 100%;
		border-radius: 1px;
		background: var(--accent);
	}
</style>
