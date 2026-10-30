<script lang="ts">
	import { Icons } from "../icons";
	import Icon from "../ui/Icon.svelte";
	import Spinner from "../ui/Spinner.svelte";
	import type { SaveState } from "./types";

	let { state, onretry }: { state: SaveState; onretry: (() => void) | null } = $props();
</script>

{#if state === "failed" && onretry}
	<button class="status" data-state={state} onclick={onretry}>Save failed, retry</button>
{:else}
	<span class="status" data-state={state} role="status">
		{#if state === "saved"}
			<Icon icon={Icons.Check} size="xs" />Saved
		{:else if state === "saving"}
			<Spinner size="xs" />Saving…
		{:else if state === "unsaved"}
			<span class="dot" aria-hidden="true"></span>Unsaved
		{:else if state === "offline"}
			Offline, not saved yet
		{:else if state === "conflict"}
			<Icon icon={Icons.Warn} size="xs" />Conflict
		{:else}
			Save failed
		{/if}
	</span>
{/if}

<style>
	.status {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		font-size: var(--text-xs);
		color: var(--fg-subtle);
		white-space: nowrap;
		&[data-state="unsaved"],
		&[data-state="saving"] {
			color: var(--fg-muted);
		}
		&[data-state="offline"],
		&[data-state="conflict"] {
			color: var(--warning);
		}
		&[data-state="failed"] {
			color: var(--danger);
		}
	}
	button.status:hover {
		text-decoration: underline;
	}
	.dot {
		width: var(--dot-sm);
		height: var(--dot-sm);
		border-radius: var(--radius-full);
		background: var(--fg-muted);
	}
</style>
