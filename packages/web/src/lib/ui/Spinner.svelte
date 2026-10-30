<script lang="ts">
	import { Icons } from "../icons";
	import Icon, { type IconSize } from "./Icon.svelte";

	let { size = "md", label }: { size?: IconSize; label?: string } = $props();
</script>

<span class="spinner"><Icon icon={Icons.Spinner} {size} spin {label} /></span>

<style>
	.spinner {
		display: inline-flex;
		color: var(--fg-muted);
	}
</style>
