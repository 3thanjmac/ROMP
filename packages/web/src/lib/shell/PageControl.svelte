<script lang="ts">
	/**
	 * Phone carousel position: one dot per window, the visible one highlighted. It follows the strip while a swipe
	 * is in flight (frameUi.stripView), not only the settled focus. Like UIPageControl it is also a scrubber: a tap
	 * or drag along it jumps straight to the window under the finger, with no carousel animation.
	 */
	import { displayTitle, layoutMode, shell } from "./shell.svelte";
	import { frameUi } from "./ui.svelte";
	import { IPHONE } from "./viewport.svelte";

	const ws = $derived(shell.active);
	const count = $derived(ws.windows.length);
	const current = $derived(Math.max(0, Math.min(count - 1, Math.round(frameUi.stripView.start * count))));
	const currentWin = $derived(ws.windows[current]);

	let el = $state<HTMLDivElement>();
	let pointer: number | null = null;

	function jump(index: number) {
		const win = ws.windows[Math.max(0, Math.min(count - 1, index))];
		if (win && win.id !== ws.focusedId) shell.focus(win.id);
	}

	/** The window whose share of the bar's width is under `clientX`. */
	function jumpTo(clientX: number) {
		if (!el) return;
		const rect = el.getBoundingClientRect();
		jump(Math.floor(((clientX - rect.left) / Math.max(1, rect.width)) * count));
	}

	function onpointerdown(e: PointerEvent) {
		if (pointer !== null || !el) return;
		pointer = e.pointerId;
		el.setPointerCapture(e.pointerId);
		frameUi.scrubbing = true;
		jumpTo(e.clientX);
	}

	function onpointermove(e: PointerEvent) {
		if (e.pointerId === pointer) jumpTo(e.clientX);
	}

	function onpointerup(e: PointerEvent) {
		if (e.pointerId !== pointer) return;
		pointer = null;
		frameUi.scrubbing = false;
	}

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
		class:scrubbing={frameUi.scrubbing}
		role="slider"
		tabindex="0"
		aria-label="Windows"
		aria-valuemin={1}
		aria-valuemax={count}
		aria-valuenow={current + 1}
		aria-valuetext={currentWin ? `${displayTitle(currentWin)}, ${current + 1} of ${count}` : undefined}
		{onpointerdown}
		{onpointermove}
		{onpointerup}
		onpointercancel={onpointerup}
		{onkeydown}
	>
		{#each ws.windows as win, i (win.id)}
			<span class="dot" class:on={i === current}></span>
		{/each}
	</div>
{/if}

<style>
	.page-control {
		position: absolute;
		top: 0;
		left: 50%;
		translate: -50% -50%;
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		padding: var(--sp-1) var(--sp-2);
		border-radius: var(--radius-full);
		background: var(--page-capsule);
		border: var(--border);
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
		cursor: pointer;
		transition: scale var(--dur);
		/* The capsule is a few px tall; this widens what a finger can grab without changing how it looks. It
		   reaches up over the desk more than down, where the bar's own buttons sit. */
		&::before {
			content: "";
			position: absolute;
			inset: calc(-1 * var(--sp-3)) calc(-1 * var(--sp-2)) calc(-1 * var(--sp-1));
		}
		&.scrubbing {
			scale: 1.15;
		}
	}
	.dot {
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
		gap: var(--sp-2);
		border: none;
		background: var(--page-capsule-ios);
		backdrop-filter: blur(var(--page-blur));
		-webkit-backdrop-filter: blur(var(--page-blur));
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
		.dot {
			transition: none;
		}
	}
</style>
