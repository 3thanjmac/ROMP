<script lang="ts">
	/** One upload in the files list: progress while it runs, the choices when it conflicts or fails. */
	import { formatSize } from "../../lib/format";
	import { Icons } from "../../lib/icons";
	import Button from "../../lib/ui/Button.svelte";
	import Icon from "../../lib/ui/Icon.svelte";
	import IconButton from "../../lib/ui/IconButton.svelte";
	import type { Upload } from "./uploads.svelte";

	interface Props {
		item: Upload;
		oncancel: () => void;
		onreplace: () => void;
		onkeepboth: () => void;
		onretry: () => void;
		ondismiss: () => void;
	}

	let { item, oncancel, onreplace, onkeepboth, onretry, ondismiss }: Props = $props();

	const active = $derived(item.status === "queued" || item.status === "uploading");
	const percent = $derived(item.total > 0 ? Math.floor((item.sent / item.total) * 100) : 0);
</script>

<li class="row" data-status={item.status}>
	<Icon icon={active ? Icons.Upload : Icons.Warn} />
	<div class="info">
		<span class="name truncate">{item.name}</span>
		{#if active}
			<progress max={item.total || 1} value={item.sent} aria-label="Uploading {item.name}"></progress>
			<span class="meta tabular">
				{#if item.status === "queued"}
					Waiting · {formatSize(item.total)}
				{:else}
					{formatSize(item.sent)} / {formatSize(item.total)} · {percent}%
				{/if}
			</span>
		{:else}
			<span class="msg" role="alert">{item.error}</span>
		{/if}
	</div>
	<div class="actions">
		{#if active}
			<IconButton size="sm" label="Cancel upload" icon={Icons.Close} onclick={oncancel} />
		{:else if item.status === "conflict"}
			<Button size="sm" onclick={onreplace}>Replace</Button>
			<Button size="sm" onclick={onkeepboth}>Keep both</Button>
			<Button size="sm" variant="ghost" onclick={ondismiss}>Skip</Button>
		{:else}
			{#if item.retryable}<Button size="sm" onclick={onretry}>Retry</Button>{/if}
			<Button size="sm" variant="ghost" onclick={ondismiss}>Dismiss</Button>
		{/if}
	</div>
</li>

<style>
	/* Same insets as FileRow: the icon and the name line up with the entries below. */
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--sp-1) var(--sp-2);
		min-height: var(--row-h);
		padding: var(--sp-1) var(--sp-2) var(--sp-1) var(--sp-3);
		list-style: none;
		> :global(.icon) {
			flex: none;
			color: var(--fg-muted);
		}
		&[data-status="conflict"] {
			> :global(.icon),
			.msg {
				color: var(--warning);
			}
		}
		&[data-status="error"] {
			> :global(.icon),
			.msg {
				color: var(--danger);
			}
		}
	}
	.info {
		display: flex;
		flex-direction: column;
		gap: var(--sp-1);
		flex: 1 1 var(--upload-info-min);
		min-width: 0;
	}
	.msg {
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--sp-1);
		margin-inline-start: auto;
	}
	progress {
		appearance: none;
		display: block;
		width: 100%;
		height: var(--progress-h);
		border: none;
		border-radius: var(--radius-full);
		overflow: hidden;
		background: var(--line);
		&::-webkit-progress-bar {
			background: var(--line);
		}
		&::-webkit-progress-value {
			background: var(--accent);
			transition: inline-size var(--dur) var(--ease);
		}
		&::-moz-progress-bar {
			background: var(--accent);
		}
	}
</style>
