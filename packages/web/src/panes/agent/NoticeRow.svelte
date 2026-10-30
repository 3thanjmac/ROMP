<script lang="ts">
	import type { NoticeItem, ShellItem } from "../../lib/agent/types";
	import { stripAnsi } from "../../lib/agent/wire";
	import { Icons } from "../../lib/icons";
	import Icon from "../../lib/ui/Icon.svelte";

	/** Compact expandable row for extension/system notices and `!command` / `$code` runs. */
	let { item }: { item: NoticeItem | ShellItem } = $props();

	const label = $derived(
		item.kind === "notice"
			? item.label
			: `${item.language === "bash" ? "$" : ">>>"} ${item.command.split("\n", 1)[0] ?? ""}`,
	);
	const body = $derived(item.kind === "notice" ? item.text : stripAnsi(item.output).trimEnd());
	const status = $derived(
		item.kind === "shell" ? (item.cancelled ? "cancelled" : item.exitCode !== null && item.exitCode !== 0 ? `exit ${item.exitCode}` : null) : null,
	);
</script>

<details class="notice" data-tone={item.kind === "notice" ? item.tone : "neutral"}>
	<summary>
		<span class="chev"><Icon icon={Icons.ChevronRight} size="sm" /></span>
		<span class="label truncate" class:mono={item.kind === "shell"}>{label}</span>
		{#if status}<span class="meta">{status}</span>{/if}
	</summary>
	{#if body}<pre>{body}</pre>{/if}
</details>

<style>
	.notice {
		min-width: 0;
		font-size: var(--text-sm);
		color: var(--fg-muted);
		&[data-tone="warning"] summary {
			color: var(--warning);
		}
		&[data-tone="danger"] summary {
			color: var(--danger);
		}
	}
	summary {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		min-height: var(--row-h);
		cursor: pointer;
		list-style: none;
		border-radius: var(--radius-sm);
		&::-webkit-details-marker {
			display: none;
		}
		&:hover {
			color: var(--fg);
		}
	}
	.chev {
		display: inline-flex;
		color: var(--fg-subtle);
		transition: rotate var(--dur);
	}
	details[open] .chev {
		rotate: 90deg;
	}
	.label {
		min-width: 0;
	}
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
	}
	pre {
		margin: 0;
		padding: var(--sp-2);
		max-height: calc(20lh + var(--sp-2) * 2);
		overflow: auto;
		background: var(--inset);
		border-radius: var(--radius-sm);
		font-size: var(--text-xs);
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
