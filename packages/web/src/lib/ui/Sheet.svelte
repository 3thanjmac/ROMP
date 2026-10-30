<script lang="ts">
	import type { Snippet } from "svelte";

	interface Props {
		open: boolean;
		/** Accessible name of the sheet. */
		label: string;
		/** Full-height sheet (Overview) instead of content height capped at --sheet-max-h. */
		full?: boolean;
		/** Content of the drag handle row, under the grip. */
		header?: Snippet;
		children: Snippet;
		onclose?: () => void;
	}

	let { open = $bindable(false), label, full = false, header, children, onclose }: Props = $props();

	// Past this share of the sheet's height, or this downward speed (px/ms), a release dismisses.
	const DISMISS_SHARE = 0.3;
	const FLING_SPEED = 0.5;
	// Content stays mounted for the slide-out; --dur-exit is far below this.
	const UNMOUNT_DELAY_MS = 400;

	let el: HTMLDialogElement;
	let mounted = $state(false);
	let pressedBackdrop = false;
	let drag: { id: number; y0: number; dy: number; lastY: number; lastT: number; speed: number } | null = null;
	let unmountTimer: number | undefined;

	$effect(() => {
		if (open) {
			clearTimeout(unmountTimer);
			mounted = true;
			if (!el.open) el.showModal();
		} else if (el.open) {
			el.close();
		}
	});

	function closed() {
		open = false;
		unmountTimer = window.setTimeout(() => (mounted = false), UNMOUNT_DELAY_MS);
		onclose?.();
	}

	function down(e: PointerEvent) {
		if (e.button !== 0 || (e.target as Element).closest("button, a, input, textarea, select")) return;
		drag = { id: e.pointerId, y0: e.clientY, dy: 0, lastY: e.clientY, lastT: e.timeStamp, speed: 0 };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		el.style.transition = "none";
	}

	function move(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.id) return;
		drag.dy = Math.max(0, e.clientY - drag.y0);
		const dt = e.timeStamp - drag.lastT;
		if (dt > 0) drag.speed = (e.clientY - drag.lastY) / dt;
		drag.lastY = e.clientY;
		drag.lastT = e.timeStamp;
		el.style.translate = `0 ${drag.dy}px`;
	}

	function up(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.id) return;
		const dismiss = drag.dy > el.offsetHeight * DISMISS_SHARE || drag.speed > FLING_SPEED;
		drag = null;
		// Clearing both inline styles in one frame transitions from the dragged offset: back to 0 (spring back)
		// or, once closed, on to 100% (slide out).
		el.style.transition = "";
		el.style.translate = "";
		if (dismiss) el.close();
	}
</script>

<dialog
	bind:this={el}
	class="sheet"
	class:full
	aria-label={label}
	onclose={closed}
	onpointerdown={(e) => (pressedBackdrop = e.target === el)}
	onclick={(e) => {
		if (pressedBackdrop && e.target === el) el.close();
		pressedBackdrop = false;
	}}
>
	{#if mounted}
		<div class="handle" role="presentation" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}>
			<span class="grip" aria-hidden="true"></span>
			{@render header?.()}
		</div>
		<div class="content">{@render children()}</div>
	{/if}
</dialog>

<style>
	.sheet {
		position: fixed;
		inset: auto 0 0 0;
		top: auto;
		width: 100%;
		max-width: 100%;
		max-height: min(var(--sheet-max-h), var(--vvh));
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		color: var(--fg);
		background: var(--surface-1);
		border: 0;
		border-top: var(--border);
		border-radius: var(--radius-xl) var(--radius-xl) 0 0;
		box-shadow: var(--shadow-lg);
		translate: 0 100%;
		transition:
			translate var(--dur-exit) var(--ease),
			overlay var(--dur-exit) allow-discrete,
			display var(--dur-exit) allow-discrete;
		&:not([open]) {
			display: none;
		}
		&[open] {
			translate: 0 0;
			transition-duration: var(--dur-enter);
		}
		&.full {
			height: calc(var(--vvh) - var(--safe-top));
			max-height: none;
		}
		&::backdrop {
			background: var(--overlay);
			opacity: 0;
			transition:
				opacity var(--dur-exit) var(--ease),
				overlay var(--dur-exit) allow-discrete,
				display var(--dur-exit) allow-discrete;
		}
		&[open]::backdrop {
			opacity: 1;
			transition-duration: var(--dur-enter);
		}
	}
	@starting-style {
		.sheet[open] {
			translate: 0 100%;
		}
		.sheet[open]::backdrop {
			opacity: 0;
		}
	}
	.handle {
		display: grid;
		justify-items: stretch;
		gap: var(--sp-2);
		padding: var(--sp-2) var(--sp-4) var(--sp-2);
		touch-action: none;
		cursor: grab;
		flex: none;
	}
	.grip {
		justify-self: center;
		width: var(--grip-w);
		height: var(--grip-h);
		border-radius: var(--radius-full);
		background: var(--line-strong);
	}
	.content {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 0 var(--sp-4) calc(var(--sp-4) + var(--safe-bottom));
	}
</style>
