<script lang="ts">
	import Chip from "../../lib/ui/Chip.svelte";
	import Popover from "../../lib/ui/Popover.svelte";
	import { tooltip } from "../../lib/ui/tooltip";
	import type { SlashSuggestion } from "./slashCommands";

	interface Props {
		id: string;
		anchor: HTMLElement | null;
		open: boolean;
		items: SlashSuggestion[];
		activeIndex: number;
		onactive: (index: number) => void;
		onpick: (item: SlashSuggestion) => void;
		ondismiss: (how: "outside" | "escape") => void;
	}

	let { id, anchor, open, items, activeIndex, onactive, onpick, ondismiss }: Props = $props();

	let panel = $state<HTMLElement | null>(null);
	// Hovering also moves `activeIndex`; only keyboard moves should scroll the list.
	let hovered = -1;

	// The panel is the listbox the composer's `aria-controls` points at.
	$effect(() => {
		if (panel) panel.id = id;
	});

	$effect(() => {
		const index = activeIndex;
		void items;
		if (!panel || index === hovered) return;
		document.getElementById(`${id}-option-${index}`)?.scrollIntoView({ block: "nearest" });
	});

	function enter(index: number) {
		hovered = index;
		onactive(index);
	}
</script>

<Popover {anchor} {open} placement="top-start" matchWidth role="listbox" label="Slash commands" bind:panel {ondismiss}>
	<div class="list">
		{#each items as item, i (item.key)}
			<!-- mousedown would move focus off the textarea; the completion itself runs on click. -->
			<button
				type="button"
				role="option"
				id="{id}-option-{i}"
				class="option"
				tabindex="-1"
				aria-selected={i === activeIndex}
				onpointerenter={() => enter(i)}
				onpointerleave={() => (hovered = -1)}
				onmousedown={e => e.preventDefault()}
				onclick={() => onpick(item)}
			>
				<span class="top">
					<span class="head">
						{#if item.subcommand}
							<span class="name"><span class="meta">/{item.command.name}</span> {item.name}</span>
						{:else}
							<span class="name">/{item.name}</span>
							{#if item.hint}<span class="meta hint">{item.hint}</span>{/if}
						{/if}
					</span>
					{#if item.source !== "builtin"}<Chip tone="fg-muted">{item.source}</Chip>{/if}
				</span>
				{#if item.description}
					<span class="meta truncate desc" aria-label={item.description} use:tooltip>{item.description}</span>
				{/if}
			</button>
		{/each}
	</div>
</Popover>

<style>
	.list {
		display: grid;
		min-width: 0;
	}
	.option {
		display: grid;
		gap: var(--sp-1);
		inline-size: 100%;
		max-width: 100%;
		min-width: 0;
		padding: var(--sp-2);
		border-radius: var(--radius-sm);
		text-align: left;
		color: var(--fg);
		&[aria-selected="true"],
		&:hover {
			background: var(--surface-1);
		}
	}
	.top,
	.head {
		display: flex;
		min-width: 0;
		gap: var(--sp-2);
	}
	.top {
		align-items: center;
	}
	.head {
		align-items: baseline;
		flex-wrap: wrap;
		column-gap: var(--sp-2);
		row-gap: 0;
	}
	.name,
	.hint {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.top :global(.chip) {
		margin-inline-start: auto;
	}
	.desc {
		display: block;
		min-width: 0;
	}
	@media (pointer: coarse) {
		.option {
			min-height: var(--tap);
		}
	}
</style>
