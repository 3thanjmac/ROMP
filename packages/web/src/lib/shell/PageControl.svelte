<script lang="ts">
	/**
	 * Phone carousel position: one dot per window, the visible one highlighted. It follows the strip while a swipe
	 * is in flight (frameUi.stripView), not only the settled focus. Pressing it never changes the page: press and
	 * drag steps one window per dot pitch of travel, once the press has been held briefly. While held it rises above
	 * the finger so the dots stay visible.
	 */
	import { displayTitle, layoutMode, shell } from "./shell.svelte";
	import { frameUi } from "./ui.svelte";
	import { IPHONE } from "./viewport.svelte";

	/** Minimum drag distance per page; the plain dots are closer together than a finger can step reliably. */
	const STEP_MIN_PX = 16;
	/** A short tick per page; navigator.vibrate exists on Android browsers, not iOS Safari. */
	const HAPTIC_MS = 10;
	/** How long a press must last before the control lifts and starts scrubbing; a shorter tap does nothing. */
	const HOLD_MS = 150;

	const ws = $derived(shell.active);
	const count = $derived(ws.windows.length);
	const current = $derived(Math.max(0, Math.min(count - 1, Math.round(frameUi.stripView.start * count))));
	const currentWin = $derived(ws.windows[current]);

	let el = $state<HTMLDivElement>();
	let track = $state<HTMLDivElement>();
	let viewWidth = $state(0);
	let trackWidth = $state(0);
	/** `active` once the press has lasted HOLD_MS; until then moves only re-anchor `x`. */
	let drag: { pointer: number; x: number; index: number; step: number; active: boolean } | null = null;
	let holdTimer: number | undefined;

	/** When there are more dots than fit, the track slides to keep the current one in view. */
	const offset = $derived.by(() => {
		const dot = track?.children[current] as HTMLElement | undefined;
		if (!dot || trackWidth <= viewWidth) return 0;
		return Math.max(0, Math.min(trackWidth - viewWidth, dot.offsetLeft + dot.offsetWidth / 2 - viewWidth / 2));
	});
	const clipped = $derived(trackWidth > viewWidth);

	/** Focuses the window at `index` (clamped); true when that changed the focus. */
	function jump(index: number): boolean {
		const win = ws.windows[Math.max(0, Math.min(count - 1, index))];
		if (!win || win.id === ws.focusedId) return false;
		shell.focus(win.id);
		return true;
	}

	function onpointerdown(e: PointerEvent) {
		// No guard on an existing drag: a new primary pointer means the old one is gone, whatever we heard about it.
		if (!el || !track || !e.isPrimary) return;
		const [a, b] = track.children;
		const pitch = a && b ? b.getBoundingClientRect().left - a.getBoundingClientRect().left : 0;
		drag = { pointer: e.pointerId, x: e.clientX, index: current, step: Math.max(STEP_MIN_PX, pitch), active: false };
		el.setPointerCapture(e.pointerId);
		clearTimeout(holdTimer);
		holdTimer = window.setTimeout(() => {
			if (!drag) return;
			drag.active = true;
			drag.index = current;
			frameUi.scrubbing = true;
		}, HOLD_MS);
	}

	function onpointermove(e: PointerEvent) {
		if (e.pointerId !== drag?.pointer) return;
		// Travel before the hold completes doesn't count; stepping is measured from where the finger was at lift-off.
		if (!drag.active) drag.x = e.clientX;
		else if (jump(drag.index + Math.trunc((e.clientX - drag.x) / drag.step)) && "vibrate" in navigator) navigator.vibrate(HAPTIC_MS);
	}

	function release() {
		clearTimeout(holdTimer);
		drag = null;
		frameUi.scrubbing = false;
	}

	/** Window-level (capture phase) and on capture loss, so a release can't slip past the control and leave it raised. */
	function onpointerend(e: PointerEvent) {
		if (e.pointerId === drag?.pointer) release();
	}

	// The control can unmount mid-drag (the bar hides for the keyboard, the window count drops, tile mode).
	$effect(() => {
		if (el) return () => drag && release();
	});

	function onkeydown(e: KeyboardEvent) {
		const target =
			e.key === "ArrowLeft" || e.key === "ArrowDown"
				? current - 1
				: e.key === "ArrowRight" || e.key === "ArrowUp"
					? current + 1
					: e.key === "Home"
						? 0
						: e.key === "End"
							? count - 1
							: null;
		if (target === null) return;
		e.preventDefault();
		jump(target);
	}
</script>

{#if count > 1 && layoutMode(ws) !== "tile"}
	<div
		bind:this={el}
		class="page-control"
		class:ios={IPHONE}
		class:held={frameUi.scrubbing}
		role="slider"
		tabindex="0"
		aria-label="Windows"
		aria-valuemin={1}
		aria-valuemax={count}
		aria-valuenow={current + 1}
		aria-valuetext={currentWin ? `${displayTitle(currentWin)}, ${current + 1} of ${count}` : undefined}
		{onpointerdown}
		{onpointermove}
		onlostpointercapture={onpointerend}
		oncontextmenu={e => e.preventDefault()}
		{onkeydown}
	>
		<!-- Clipped dots fade out at whichever edge still has more of them beyond it. -->
		<div
			class="view"
			class:clipped
			bind:clientWidth={viewWidth}
			style:--fade-start={offset > 0 ? "var(--page-fade)" : "0px"}
			style:--fade-end={offset < trackWidth - viewWidth - 1 ? "var(--page-fade)" : "0px"}
		>
			<div class="track" bind:this={track} bind:clientWidth={trackWidth} style:translate="{-offset}px 0">
				{#each ws.windows as win, i (win.id)}
					<span class="dot" class:on={i === current}></span>
				{/each}
			</div>
		</div>
	</div>
{/if}

<svelte:window onpointerupcapture={onpointerend} onpointercancelcapture={onpointerend} onblur={() => drag && release()} />

<style>
	.page-control {
		position: relative;
		display: flex;
		min-width: 0;
		max-width: 100%;
		padding: var(--sp-2) var(--sp-3);
		border-radius: var(--radius-full);
		background: var(--page-capsule);
		border: var(--border);
		touch-action: none;
		cursor: grab;
		transition:
			translate var(--dur) var(--ease-out-quint),
			scale var(--dur) var(--ease-out-quint);
		/* Grabbable over the bar's full height without reaching sideways into the neighbouring buttons. */
		&::before {
			content: "";
			position: absolute;
			inset: calc(-1 * var(--sp-3)) 0;
		}
		/* Lifted over the page, it frosts what's behind it so the dots stay legible. */
		&.held {
			translate: 0 calc(-1 * var(--page-lift));
			scale: 1.15;
			cursor: grabbing;
			backdrop-filter: blur(var(--page-blur));
			-webkit-backdrop-filter: blur(var(--page-blur));
		}
	}
	.view {
		min-width: 0;
		overflow: hidden;
		&.clipped {
			mask-image: linear-gradient(
				to right,
				transparent,
				black var(--fade-start),
				black calc(100% - var(--fade-end)),
				transparent
			);
		}
	}
	.track {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		width: max-content;
		transition: translate var(--dur) var(--ease);
	}
	.dot {
		flex: none;
		width: var(--dot-sm);
		height: var(--dot-sm);
		border-radius: var(--radius-full);
		background: var(--fg-subtle);
		opacity: 0.5;
		transition:
			opacity var(--dur),
			background var(--dur);
		&.on {
			background: var(--fg);
			opacity: 1;
		}
	}
	/* UIPageControl: 8px white dots, the inactive ones translucent, on a blurred dark capsule. */
	.ios {
		border: none;
		background: var(--page-capsule-ios);
		backdrop-filter: blur(var(--page-blur));
		-webkit-backdrop-filter: blur(var(--page-blur));
		.track {
			gap: var(--sp-2);
		}
		.dot {
			width: var(--dot-md);
			height: var(--dot-md);
			background: var(--page-dot-ios-dim);
			opacity: 1;
			&.on {
				background: var(--page-dot-ios);
			}
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.page-control,
		.track,
		.dot {
			transition: none;
		}
	}
</style>
