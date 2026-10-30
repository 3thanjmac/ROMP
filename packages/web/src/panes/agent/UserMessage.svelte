<script lang="ts">
	let {
		text,
		images = [],
		note = null,
		pending = false,
	}: {
		text: string;
		images?: string[];
		/** `.meta` line under the bubble, e.g. "Queued: steer". */
		note?: string | null;
		/** Sent from this tab and not confirmed yet. */
		pending?: boolean;
	} = $props();
</script>

<div class="user" class:pending>
	<div class="bubble">
		{#if text}<p>{text}</p>{/if}
		{#each images as src, i (i)}<img {src} alt="Attachment {i + 1}" />{/each}
	</div>
	{#if note}<span class="meta">{note}</span>{/if}
</div>

<style>
	.user {
		display: grid;
		justify-items: end;
		gap: var(--sp-1);
		min-width: 0;
	}
	.bubble {
		display: grid;
		gap: var(--sp-2);
		max-width: var(--bubble-max-w);
		padding: var(--sp-2) var(--sp-3);
		background: var(--surface-2);
		border-radius: var(--radius-lg);
		min-width: 0;
	}
	p {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.pending .bubble {
		color: var(--fg-muted);
	}
	img {
		max-width: 100%;
		border-radius: var(--radius-md);
	}
</style>
