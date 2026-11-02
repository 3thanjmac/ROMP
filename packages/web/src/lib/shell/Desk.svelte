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
			if (touching) return;
			const index = ws.windows.findIndex((w) => w.id === id);
			if (Math.abs(track.scrollLeft - index * track.clientWidth) > 1) slideTo(index, behavior === "smooth" ? SLIDE_MS : 0);
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

	// Opening or closing a window changes the scroll width without a scroll event; the page control reads this.
	$effect(() => {
		void ws.windows.length;
		void active;
		measureView();
	});

	// The phone carousel pages itself instead of using CSS scroll snap: the browser's snap animation is slow and
	// its duration can't be set. The finger still drags the native scroller; on release the momentum is cut
	// (overflow hidden while `sliding`) and a timed ease-out lands on the next or nearest page.
	/** Release-to-rest time of a carousel swipe. */
	const SLIDE_MS = 280;
	/** Release speed (px/ms) that pages in the swipe's direction however far the finger moved. */
	const FLICK_SPEED = 0.3;
	/** Scroll samples older than this at release don't count toward the flick speed. */
	const SAMPLE_MS = 100;

	let touching = false;
	let sliding = $state(false);
	let slideFrame = 0;
	let startPage = 0;
	let samples: Array<{ t: number; x: number }> = [];

	function stopSlide() {
		cancelAnimationFrame(slideFrame);
		sliding = false;
	}

	/** Eases the carousel to page `index` over `ms`, then focuses that window. */
	function slideTo(index: number, ms: number) {
		if (!track) return;
		stopSlide();
		const el = track;
		const from = el.scrollLeft;
		const to = Math.max(0, Math.min(ws.windows.length - 1, index)) * el.clientWidth;
		if (ms <= 0 || Math.abs(to - from) < 1) {
			el.scrollLeft = to;
			focusPage();
			return;
		}
		sliding = true;
		const t0 = performance.now();
		const step = (now: number) => {
			const p = Math.min(1, (now - t0) / ms);
			el.scrollLeft = from + (to - from) * (1 - (1 - p) ** 3);
			if (p < 1) {
				slideFrame = requestAnimationFrame(step);
				return;
			}
			sliding = false;
			focusPage();
		};
		slideFrame = requestAnimationFrame(step);
	}

	function focusPage() {
		if (!carousel || !track) return;
		const win = ws.windows[Math.round(track.scrollLeft / Math.max(1, track.clientWidth))];
		if (win && win.id !== ws.focusedId) shell.focus(win.id);
	}

	function ontouchstart() {
		if (!carousel || !track) return;
		touching = true;
		stopSlide();
		startPage = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
		samples = [];
	}

	function ontouchend(e: TouchEvent) {
		if (!touching || e.touches.length > 0 || !track) return;
		touching = false;
		const width = Math.max(1, track.clientWidth);
		const pos = track.scrollLeft / width;
		if (Math.abs(pos - startPage) * width < 1) return;
		const now = performance.now();
		const recent = samples.filter((s) => now - s.t <= SAMPLE_MS);
		const first = recent[0];
		const last = recent.at(-1);
		const speed = first && last && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
		const target = speed > FLICK_SPEED ? Math.floor(pos) + 1 : speed < -FLICK_SPEED ? Math.ceil(pos) - 1 : Math.round(pos);
		slideTo(Math.max(startPage - 1, Math.min(startPage + 1, target)), viewport.reducedMotion ? 0 : SLIDE_MS);
	}

	let settleTimer: number | undefined;
	/** A scroll the carousel didn't drive (trackpad, wheel, keyboard) came to rest: page it too. */
	function settled() {
		if (!carousel || !track || touching || sliding) return;
		const pos = track.scrollLeft / Math.max(1, track.clientWidth);
		if (Math.abs(pos - Math.round(pos)) * track.clientWidth > 1) {
			slideTo(Math.round(pos), viewport.reducedMotion ? 0 : SLIDE_MS);
		} else {
			focusPage();
		}
	}
	function onscroll() {
		measureView();
		if (!carousel || !track) return;
		if (touching) {
			samples.push({ t: performance.now(), x: track.scrollLeft });
			if (samples.length > 8) samples.shift();
		}
		clearTimeout(settleTimer);
		settleTimer = window.setTimeout(settled, 120);
	}

	// Passive listeners on the track: they only observe the swipe, the finger still scrolls natively.
	$effect(() => {
		const el = track;
		if (!el) return;
		const opts = { passive: true };
		el.addEventListener("touchstart", ontouchstart, opts);
		el.addEventListener("touchend", ontouchend, opts);
		el.addEventListener("touchcancel", ontouchend, opts);
		return () => {
			el.removeEventListener("touchstart", ontouchstart);
			el.removeEventListener("touchend", ontouchend);
			el.removeEventListener("touchcancel", ontouchend);
			stopSlide();
			clearTimeout(settleTimer);
		};
	});
</script>

<div class="desk" class:tile hidden={!active} data-workspace={ws.id}>
	<div
		class="track"
		class:tile
		class:carousel
		class:sliding
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
			scrollbar-width: none;
			> .slot {
				width: 100%;
			}
			/* Cuts the native momentum while the release animation runs; scrollLeft still moves the strip. */
			&.sliding {
				overflow-x: hidden;
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
