<script lang="ts">
	import Button from "../ui/Button.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import { SHORTCUTS } from "./keyboard";
	import { frameUi } from "./ui.svelte";
</script>

<Dialog bind:open={frameUi.shortcuts} title="Keyboard shortcuts">
	<table>
		<tbody>
			{#each SHORTCUTS as s (s.action)}
				<tr>
					<td>{s.action}</td>
					<td class="keys">
						{#each s.keys as k (k)}<kbd>{k}</kbd>{/each}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
	{#snippet footer()}
		<Button onclick={() => (frameUi.shortcuts = false)}>Close</Button>
	{/snippet}
</Dialog>

<style>
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-sm);
	}
	td {
		padding: var(--sp-1) 0;
		vertical-align: top;
	}
	.keys {
		text-align: end;
		white-space: nowrap;
		padding-inline-start: var(--sp-3);
		kbd + kbd {
			margin-inline-start: var(--sp-1);
		}
	}
</style>
