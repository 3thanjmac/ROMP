<script lang="ts">
	import { Icons } from "../icons";
	import Icon from "./Icon.svelte";
	import { tooltip } from "./tooltip";

	let { count }: { count: number } = $props();
</script>

{#if count > 1}
	<span class="clients meta tabular" role="img" aria-label="{count} clients attached" use:tooltip>
		<Icon icon={Icons.Clients} size="sm" />{count}
	</span>
{/if}

<style>
	.clients {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		flex: none;
	}
</style>
