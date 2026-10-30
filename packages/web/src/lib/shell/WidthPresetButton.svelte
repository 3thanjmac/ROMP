<script lang="ts">
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import { tooltip } from "../ui/tooltip";
	import { presetIndex, WIDTH_LABELS, WIDTH_PRESETS } from "./layout";
	import { shell } from "./shell.svelte";
	import WidthMini from "./WidthMini.svelte";

	let { id, width }: { id: string; width: number } = $props();
	const current = $derived(presetIndex(width));
</script>

<Menu label="Column width" placement="bottom-end">
	{#snippet trigger(props)}
		<button {...props} class="preset" aria-label="Width: {WIDTH_LABELS[current]}" use:tooltip>
			<WidthMini width={WIDTH_PRESETS[current] ?? width} />
		</button>
	{/snippet}
	{#each WIDTH_PRESETS as preset, i (preset)}
		<MenuItem checked={i === current} onselect={() => shell.setWidth(id, preset)}>
			<span class="row"><WidthMini width={preset} />{WIDTH_LABELS[i]}</span>
		</MenuItem>
	{/each}
</Menu>

<style>
	.preset {
		display: inline-grid;
		place-items: center;
		height: var(--titlebar-h);
		padding: 0 var(--sp-1);
		border-radius: var(--radius-sm);
		flex: none;
		&:hover {
			background: var(--surface-3);
		}
	}
	.row {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-2);
	}
</style>
