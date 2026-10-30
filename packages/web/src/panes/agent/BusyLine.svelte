<script lang="ts">
	import { formatClock } from "../../lib/agent/format";
	import type { Activity } from "../../lib/agent/types";

	let { since, activity, tool }: { since: number; activity: Activity | null; tool: string | null } = $props();

	let now = $state(Date.now());

	$effect(() => {
		const timer = window.setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	const detail = $derived.by(() => {
		if (activity?.kind === "compacting") return "Compacting context";
		if (activity?.kind === "retry") return `Retrying (${activity.attempt}/${activity.maxAttempts})`;
		return tool ? `Running ${tool}` : null;
	});
</script>

<div class="busy" role="status">
	<span class="dot" aria-hidden="true"></span>
	<span class="meta tabular">Working · {formatClock(now - since)}{detail ? ` · ${detail}` : ""}</span>
</div>
{#if activity?.kind === "retry" && activity.message}
	<p class="meta retry">{activity.message}</p>
{/if}

<style>
	.busy {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
	}
	.dot {
		width: var(--dot-sm);
		height: var(--dot-sm);
		border-radius: var(--radius-full);
		background: var(--accent);
		flex: none;
	}
	@media (prefers-reduced-motion: no-preference) {
		.dot {
			animation: pulse var(--dur-pulse) ease-in-out infinite;
		}
	}
	.retry {
		overflow-wrap: anywhere;
	}
</style>
