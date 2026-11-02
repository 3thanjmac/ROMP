<script lang="ts">
	/**
	 * Phone carousel position: one dot per window, the visible one highlighted. It follows the strip while a swipe
	 * is in flight (frameUi.stripView), not only the settled focus. Decorative: the Overview button next to it
	 * carries the same position as text and is the control for picking a window.
	 */
	import { layoutMode, shell } from "./shell.svelte";
	import { frameUi } from "./ui.svelte";
	import { IPHONE } from "./viewport.svelte";

	const ws = $derived(shell.active);
	const count = $derived(ws.windows.length);
	const current = $derived(Math.max(0, Math.min(count - 1, Math.round(frameUi.stripView.start * count))));
</script>

{#if count > 1 && layoutMode(ws) !== "tile"}
	<div class="page-control" class:ios={IPHONE} aria-hidden="true">
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
		pointer-events: none;
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
		padding: var(--sp-1) var(--sp-2);
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
		.dot {
			transition: none;
		}
	}
</style>
