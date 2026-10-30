<script lang="ts">
	/** Scroll-mode minimap: one rect per column (width ∝ column width), focused in accent. Click focuses. */
	import { tooltip } from "../ui/tooltip";
	import { displayTitle, shell } from "./shell.svelte";
	import { frameUi } from "./ui.svelte";

	const ws = $derived(shell.active);
</script>

{#if ws.windows.length > 1}
	<div class="map" role="group" aria-label="Columns">
		{#each ws.windows as win (win.id)}
			<button
				class="rect"
				class:focused={win.id === ws.focusedId}
				style:--w={win.width}
				aria-label={displayTitle(win)}
				aria-current={win.id === ws.focusedId}
				onclick={() => shell.focus(win.id, { keyboard: true })}
				use:tooltip
			></button>
		{/each}
		<span
			class="view"
			aria-hidden="true"
			style:left="{frameUi.stripView.start * 100}%"
			style:width="{(frameUi.stripView.end - frameUi.stripView.start) * 100}%"
		></span>
	</div>
{/if}

<style>
	.map {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--map-gap);
		min-width: 0;
		padding-block: var(--map-gap);
		overflow: hidden;
	}
	.rect {
		flex: none;
		height: var(--map-h);
		width: calc(var(--w) * var(--map-unit));
		border-radius: var(--radius-xs);
		background: var(--line-strong);
		transition: background var(--dur-fast);
		&:hover {
			background: var(--fg-subtle);
		}
		&.focused {
			background: var(--accent);
		}
	}
	.view {
		position: absolute;
		inset-block: 0;
		border: 1px solid var(--fg-muted);
		border-radius: var(--radius-xs);
		pointer-events: none;
	}
</style>
