<script lang="ts" module>
	export interface WheelOption {
		value: string;
		label: string;
		/** Muted trailing text, e.g. a provider. */
		detail?: string;
	}
</script>

<script lang="ts">
	import { viewport } from "../shell/viewport.svelte";

	interface Props {
		/** Accessible name of the listbox. */
		label: string;
		options: WheelOption[];
		value: string;
		/** The wheel came to rest on another option (scrolling, a click, or the keyboard). */
		onchange: (value: string) => void;
	}

	let { label, options, value, onchange }: Props = $props();

	const id = $props.id();
	/** Rows a PageUp/PageDown moves. */
	const PAGE = 4;
	/** Browsers without `scrollend` settle after this long without a scroll event. */
	const SETTLE_MS = 150;

	let list: HTMLElement | null = $state(null);
	/** The option under the selection band, live while scrolling. */
	let index = $state(0);
	let settleTimer: ReturnType<typeof setTimeout> | undefined;

	const selected = $derived(options.findIndex((o) => o.value === value));

	function rowHeight(): number {
		return list?.querySelector<HTMLElement>("[role=option]")?.getBoundingClientRect().height || 1;
	}

	/** The option centered in the band. Padding of two rows above the first option makes `scrollTop / row` its index. */
	function nearest(): number {
		if (!list) return 0;
		return Math.max(0, Math.min(options.length - 1, Math.round(list.scrollTop / rowHeight())));
	}

	function scrollTo(i: number, smooth: boolean) {
		if (!list) return;
		const behavior = smooth && !viewport.reducedMotion ? "smooth" : "instant";
		list.scrollTo({ top: i * rowHeight(), behavior });
	}

	function settle() {
		const option = options[nearest()];
		if (option && option.value !== value) onchange(option.value);
	}

	function onscroll() {
		index = nearest();
		if (!("onscrollend" in window)) {
			clearTimeout(settleTimer);
			settleTimer = setTimeout(settle, SETTLE_MS);
		}
	}

	function onkeydown(e: KeyboardEvent) {
		const last = options.length - 1;
		const to =
			e.key === "ArrowDown" ? index + 1
			: e.key === "ArrowUp" ? index - 1
			: e.key === "PageDown" ? index + PAGE
			: e.key === "PageUp" ? index - PAGE
			: e.key === "Home" ? 0
			: e.key === "End" ? last
			: null;
		if (to === null) return;
		e.preventDefault();
		scrollTo(Math.max(0, Math.min(last, to)), false);
	}

	function attach(node: HTMLElement) {
		list = node;
		node.addEventListener("scrollend", settle);
		return () => {
			node.removeEventListener("scrollend", settle);
			clearTimeout(settleTimer);
			if (list === node) list = null;
		};
	}

	// Follow the value from outside (first open, a clamp, a server answer): jump without animating.
	$effect(() => {
		const i = selected;
		if (!list || i < 0) return;
		index = i;
		if (nearest() !== i) scrollTo(i, false);
	});
</script>

<div class="wheel">
	<div
		class="list"
		role="listbox"
		aria-label={label}
		aria-activedescendant={options.length > 0 ? `${id}-${index}` : undefined}
		tabindex="0"
		{onscroll}
		{onkeydown}
		{@attach attach}
	>
		{#each options as option, i (option.value)}
			<!-- mousedown would move focus off the listbox; the click scrolls the option into the band. -->
			<button
				type="button"
				role="option"
				id="{id}-{i}"
				aria-selected={i === index}
				class:current={i === index}
				tabindex="-1"
				onmousedown={(e) => e.preventDefault()}
				onclick={() => scrollTo(i, true)}
			>
				<span class="truncate">{option.label}</span>
				{#if option.detail}<span class="detail truncate">{option.detail}</span>{/if}
			</button>
		{/each}
	</div>
</div>

<style>
	.wheel {
		position: relative;
		min-width: 0;
		/* The selection band, behind the rows. */
		&::before {
			content: "";
			position: absolute;
			inset-inline: 0;
			inset-block-start: calc(var(--wheel-row-h) * 2);
			block-size: var(--wheel-row-h);
			background: var(--surface-3);
			border-radius: var(--radius-md);
			pointer-events: none;
		}
	}
	.list {
		position: relative;
		block-size: calc(var(--wheel-row-h) * 5);
		padding-block: calc(var(--wheel-row-h) * 2);
		overflow-y: auto;
		overscroll-behavior: contain;
		scroll-snap-type: y mandatory;
		scrollbar-width: none;
		border-radius: var(--radius-md);
		mask-image: linear-gradient(to bottom, transparent, black 35%, black 65%, transparent);
		&::-webkit-scrollbar {
			display: none;
		}
	}
	[role="option"] {
		inline-size: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-2);
		block-size: var(--wheel-row-h);
		padding-inline: var(--sp-2);
		scroll-snap-align: center;
		color: var(--fg-muted);
		font-size: var(--text-sm);
		white-space: nowrap;
		cursor: pointer;
		transition: color var(--dur-fast);
		&:hover {
			color: var(--fg);
		}
		&.current {
			color: var(--fg);
			font-weight: 500;
		}
	}
	.detail {
		flex: none;
		max-inline-size: 45%;
		font-size: var(--text-xs);
		font-weight: 400;
		color: var(--fg-subtle);
	}
</style>
