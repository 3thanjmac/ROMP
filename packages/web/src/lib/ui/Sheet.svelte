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
	/** Downward travel (px) before a press on the sheet becomes a drag instead of a tap. */
	const DRAG_SLOP = 8;
	/** After a drag, the click the browser may still deliver to the pressed control is swallowed this long. */
	const CLICK_GUARD_MS = 400;
	// Content stays mounted for the slide-out; --dur-exit is far below this.
	const UNMOUNT_DELAY_MS = 400;

	let el: HTMLDialogElement;
	let mounted = $state(false);
	let pressedBackdrop = false;
	/**
	 * A press anywhere on the sheet, buttons included. Its first movement decides: sideways, upward, or inside
	 * content that is scrolled down, it is left to the browser ("native"); otherwise the sheet claims it ("pull",
	 * native scrolling and rubber-banding are cancelled) and past DRAG_SLOP follows the finger ("drag").
	 */
	let drag: {
		id: number;
		x0: number;
		y0: number;
		dy: number;
		lastY: number;
		lastT: number;
		speed: number;
		state: "pending" | "native" | "pull" | "drag";
	} | null = null;
	let clickGuardUntil = 0;
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

	// Not an attribute handler: Svelte registers touchmove as passive, and this one has to cancel scrolling.
	$effect(() => {
		const touchmove = (e: TouchEvent) => {
			const t = e.touches[0];
			if (!drag || !t) return;
			if (drag.state === "pending") decide(t.clientX, t.clientY, e.target);
			if ((drag.state === "pull" || drag.state === "drag") && e.cancelable) e.preventDefault();
		};
		el.addEventListener("touchmove", touchmove, { passive: false });
		return () => el.removeEventListener("touchmove", touchmove);
	});

	function closed() {
		open = false;
		unmountTimer = window.setTimeout(() => (mounted = false), UNMOUNT_DELAY_MS);
		onclose?.();
	}

	/** Some scroller between `target` and the sheet is scrolled down, so a downward drag scrolls it back. */
	function scrolledDown(target: EventTarget | null): boolean {
		for (let n = target instanceof Element ? target : null; n && n !== el; n = n.parentElement) {
			if (n.scrollTop > 0) return true;
		}
		return false;
	}

	function decide(x: number, y: number, target: EventTarget | null) {
		if (!drag) return;
		const dx = x - drag.x0;
		const dy = y - drag.y0;
		if (dx === 0 && dy === 0) return;
		drag.state = Math.abs(dx) > Math.abs(dy) || dy < 0 || scrolledDown(target) ? "native" : "pull";
	}

	function down(e: PointerEvent) {
		pressedBackdrop = e.target === el;
		const target = e.target as Element;
		if (e.button !== 0 || pressedBackdrop || target.closest("input, textarea, select, [data-sheet-nodrag]")) return;
		drag = {
			id: e.pointerId,
			x0: e.clientX,
			y0: e.clientY,
			dy: 0,
			lastY: e.clientY,
			lastT: e.timeStamp,
			speed: 0,
			state: "pending",
		};
	}

	function move(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.id) return;
		if (drag.state === "pending") decide(e.clientX, e.clientY, e.target);
		if (drag.state === "native" || drag.state === "pending") return;
		const dt = e.timeStamp - drag.lastT;
		if (dt > 0) drag.speed = (e.clientY - drag.lastY) / dt;
		drag.lastY = e.clientY;
		drag.lastT = e.timeStamp;
		drag.dy = Math.max(0, e.clientY - drag.y0);
		if (drag.state === "pull") {
			if (drag.dy <= DRAG_SLOP) return;
			drag.state = "drag";
			// The pressed control loses the pointer: it neither stays pressed nor fires on release.
			el.setPointerCapture(e.pointerId);
			el.style.transition = "none";
		}
		el.style.translate = `0 ${drag.dy}px`;
	}

	function up(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.id) return;
		const dragged = drag.state === "drag";
		const dismiss = dragged && (drag.dy > el.offsetHeight * DISMISS_SHARE || drag.speed > FLING_SPEED);
		drag = null;
		if (!dragged) return;
		clickGuardUntil = e.timeStamp + CLICK_GUARD_MS;
		// Clearing both inline styles in one frame transitions from the dragged offset: back to 0 (spring back)
		// or, once closed, on to 100% (slide out).
		el.style.transition = "";
		el.style.translate = "";
		if (dismiss && e.type === "pointerup") el.close();
	}
</script>

<dialog
	bind:this={el}
	class="sheet"
	class:full
	aria-label={label}
	onclose={closed}
	onpointerdown={down}
	onpointermove={move}
	onpointerup={up}
	onpointercancel={up}
	onclickcapture={(e) => {
		if (e.timeStamp >= clickGuardUntil) return;
		e.preventDefault();
		e.stopPropagation();
	}}
	onclick={(e) => {
		if (pressedBackdrop && e.target === el) el.close();
		pressedBackdrop = false;
	}}
>
	{#if mounted}
		<div class="handle">
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
