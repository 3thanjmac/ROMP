<script module lang="ts">
	import type { IconComponent } from "../icons";

	export interface SegmentedOption<V extends string> {
		value: V;
		label: string;
		icon?: IconComponent;
	}
</script>

<script lang="ts" generics="T extends string">
	import Icon from "./Icon.svelte";
	import { tooltip } from "./tooltip";
	interface Props {
		options: SegmentedOption<T>[];
		value: T;
		/** Accessible name of the radiogroup. */
		label: string;
		/** Show icons only; each option's label becomes its aria-label + tooltip. */
		iconOnly?: boolean;
		disabled?: boolean;
		onchange?: (value: T) => void;
	}

	let { options, value = $bindable(), label, iconOnly = false, disabled = false, onchange }: Props = $props();

	let group: HTMLDivElement;

	function select(next: T) {
		if (next === value || disabled) return;
		value = next;
		onchange?.(next);
	}

	function onkeydown(e: KeyboardEvent) {
		const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
		if (!step) return;
		e.preventDefault();
		const i = options.findIndex((o) => o.value === value);
		const next = options[(i + step + options.length) % options.length];
		if (!next) return;
		select(next.value);
		group.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
	}
</script>

<div class="segmented" role="radiogroup" aria-label={label} aria-disabled={disabled} bind:this={group}>
	{#each options as o (o.value)}
		{#if iconOnly}
			<button
				role="radio"
				aria-checked={o.value === value}
				aria-label={o.label}
				tabindex={o.value === value ? 0 : -1}
				data-value={o.value}
				{disabled}
				onclick={() => select(o.value)}
				{onkeydown}
				use:tooltip
			>
				{#if o.icon}<Icon icon={o.icon} size="sm" />{/if}
			</button>
		{:else}
			<button
				role="radio"
				aria-checked={o.value === value}
				tabindex={o.value === value ? 0 : -1}
				data-value={o.value}
				{disabled}
				onclick={() => select(o.value)}
				{onkeydown}
			>
				{#if o.icon}<Icon icon={o.icon} size="sm" />{/if}
				<span>{o.label}</span>
			</button>
		{/if}
	{/each}
</div>

<style>
	.segmented {
		display: inline-flex;
		padding: var(--seg-inset);
		gap: var(--seg-inset);
		background: var(--surface-1);
		border: var(--border);
		border-radius: var(--radius-md);
		flex: none;
	}
	button {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		min-height: calc(1lh + var(--sp-1) * 2);
		padding: 0 var(--sp-2);
		border-radius: var(--radius-sm);
		color: var(--fg-muted);
		font-size: var(--text-sm);
		font-weight: 500;
		white-space: nowrap;
		transition:
			background var(--dur-fast),
			color var(--dur-fast);
		&:hover:not([disabled]) {
			color: var(--fg);
		}
		&:active:not([disabled]) {
			background: var(--surface-2);
		}
		&[aria-checked="true"] {
			background: var(--surface-3);
			color: var(--fg);
		}
		&[disabled] {
			opacity: 0.6;
			cursor: not-allowed;
		}
	}
	@media (pointer: coarse) {
		button {
			min-height: calc(var(--tap) - var(--sp-2));
			padding: 0 var(--sp-3);
		}
	}
</style>
