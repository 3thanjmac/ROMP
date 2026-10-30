<script lang="ts">
	let { label }: { label: string } = $props();
</script>

<div class="section meta" role="presentation">{label}</div>

<style>
	.section {
		padding: var(--sp-2) var(--sp-2) var(--sp-1);
		font-weight: 500;
		&:not(:first-child) {
			margin-top: var(--sp-1);
			border-top: var(--border);
		}
	}
</style>
