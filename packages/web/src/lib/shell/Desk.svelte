<script lang="ts">
	/**
	 * One workspace's windows. Scroll and tile mode render the same keyed frames inside the same track, so
	 * toggling the mode (or resizing) never remounts a pane: scroll mode lays the track out as a horizontal
	 * strip, tile mode positions each frame absolutely from the dwindle tree. Phones always use scroll mode.
	 */
	import type { Workspace } from "@romp/protocol";
	import { tileRects, tileSplits } from "./layout";
	import { layoutMode, shell } from "./shell.svelte";
	import SplitHandle from "./SplitHandle.svelte";
	import { frameUi } from "./ui.svelte";
	import { viewport } from "./viewport.svelte";
	import WindowFrame from "./WindowFrame.svelte";

	let { ws, active }: { ws: Workspace; active: boolean } = $props();

	let track = $state<HTMLDivElement>();
	const tile = $derived(layoutMode(ws) === "tile");
	const phone = $derived(viewport.layout === "phone");
	const carousel = $derived(!tile && phone);
	const rects = $derived(tile ? tileRects(ws.tile) : null);
	const splits = $derived(tile ? tileSplits(ws.tile) : []);

	// Tile inserts split along the longer side of the area they land in. A resize (rotation, breakpoint
	// change) also re-aligns the strip, since its scroll offset no longer matches a column edge.
	$effect(() => {
		if (!active || !track) return;
		const el = track;
		const ro = new ResizeObserver(() => {
			if (el.clientHeight > 0) shell.aspect = el.clientWidth / el.clientHeight;
			reveal("instant");
			measureView();
		});
		ro.observe(el);
		return () => ro.disconnect();
	});

	/** Scrolls the focused column into view (scroll mode only). */
	function reveal(behavior: ScrollBehavior) {
		const id = ws.focusedId;
		if (tile || !active || !id || !track) return;
		const el = track.querySelector<HTMLElement>(`[data-slot="${CSS.escape(id)}"]`);
		if (!el) return;
		if (carousel) {
			if (Math.abs(track.scrollLeft - el.offsetLeft) > 1) track.scrollTo({ left: el.offsetLeft, behavior });
		} else {
			el.scrollIntoView({ inline: "nearest", block: "nearest", behavior });
		}
	}

	// On the phone carousel a settled swipe sets the focus, so this only scrolls when focus changed some other
	// way. The focused column's width is a dependency too: a wider preset may push it past the edge.
	$effect(() => {
		void ws.windows.find((w) => w.id === ws.focusedId)?.width;
		void carousel;
		reveal(viewport.reducedMotion ? "instant" : "smooth");
	});

	function measureView() {
		if (!active || tile || !track || track.scrollWidth === 0) return;
		frameUi.stripView = {
			start: track.scrollLeft / track.scrollWidth,
			end: (track.scrollLeft + track.clientWidth) / track.scrollWidth,
		};
	}

	let settleTimer: number | undefined;
	function settled() {
		if (!carousel || !track) return;
		const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
		const win = ws.windows[i];
		if (win && win.id !== ws.focusedId) shell.focus(win.id);
	}
	function onscroll() {
		measureView();
		if (!carousel) return;
		clearTimeout(settleTimer);
		settleTimer = window.setTimeout(settled, 120);
	}
</script>

<div class="desk" class:tile hidden={!active} data-workspace={ws.id}>
	<div
		class="track"
		class:tile
		class:carousel
		bind:this={track}
		{onscroll}
		onscrollend={settled}
	>
		{#each ws.windows as win (win.id)}
			{@const r = rects?.get(win.id)}
			<div
				class="slot"
				data-slot={win.id}
				style:--w={tile ? r?.w : win.width}
				style:--x={r?.x}
				style:--y={r?.y}
				style:--h={r?.h}
			>
				<WindowFrame
					{win}
					focused={active && ws.focusedId === win.id}
					visible={active}
					showWidth={!tile && !phone}
					bare={carousel}
				/>
			</div>
		{/each}
		{#if tile && track}
			{#each splits as split (split.path)}
				<SplitHandle {split} {track} />
			{/each}
		{/if}
	</div>
</div>

<style>
	.desk {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		&[hidden] {
			display: none;
		}
	}
	.track {
		display: flex;
		gap: var(--pane-gap);
		height: 100%;
		overflow-x: auto;
		overflow-y: hidden;
		overscroll-behavior-x: contain;
		/* The top bar minimap shows the strip position. */
		scrollbar-width: none;
		> .slot {
			flex: none;
			height: 100%;
			/* k columns of this width fill the strip exactly: k = 1 / width, with k - 1 gaps between them. */
			width: calc((100% - (1 / var(--w) - 1) * var(--pane-gap)) * var(--w));
		}
		&.carousel {
			gap: 0;
			scroll-snap-type: x mandatory;
			scrollbar-width: none;
			> .slot {
				width: 100%;
				scroll-snap-align: start;
				scroll-snap-stop: always;
			}
		}
		&.tile {
			position: absolute;
			inset: 0 calc(-1 * var(--pane-gap)) calc(-1 * var(--pane-gap)) 0;
			height: auto;
			overflow: visible;
			> .slot {
				position: absolute;
				left: calc(var(--x) * 100%);
				top: calc(var(--y) * 100%);
				width: calc(var(--w) * 100% - var(--pane-gap));
				height: calc(var(--h) * 100% - var(--pane-gap));
			}
		}
	}
</style>
