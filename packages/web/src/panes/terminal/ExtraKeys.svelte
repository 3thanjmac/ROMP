<script lang="ts">
	/**
	 * Touch key row under a focused terminal. Keys never take focus, so the soft keyboard stays up (and in select
	 * mode the native text selection survives). Ctrl/Alt: tap latches for the next key, double-tap locks, tap
	 * again releases. Arrows repeat while held. In select mode the row turns into the selection toolbar.
	 */
	import type { Attachment } from "svelte/attachments";
	import { Icons } from "../../lib/icons";
	import Icon from "../../lib/ui/Icon.svelte";
	import { KEY_SEQ, type ModState, nextModState } from "./keys";

	interface Props {
		ctrl: ModState;
		alt: ModState;
		/** Sends a key sequence through the modifier pipeline. */
		onkey: (seq: string) => void;
		onhide: () => void;
		/** Select mode: the terminal text is shown as a natively selectable layer. */
		selecting: boolean;
		/** The selectable layer holds a non-collapsed selection. */
		hasSelection: boolean;
		/** The snapshot has any non-blank text. */
		hasText: boolean;
		/** Copy just succeeded. */
		copied: boolean;
		canPaste: boolean;
		onselect: () => void;
		onpaste: () => void;
		oncopy: () => void;
		onselectall: () => void;
		ondone: () => void;
	}

	let {
		ctrl = $bindable(),
		alt = $bindable(),
		onkey,
		onhide,
		selecting,
		hasSelection,
		hasText,
		copied,
		canPaste,
		onselect,
		onpaste,
		oncopy,
		onselectall,
		ondone,
	}: Props = $props();

	const DOUBLE_TAP_MS = 300;
	const REPEAT_DELAY_MS = 400;
	const REPEAT_EVERY_MS = 50;
	/** A click this soon after a handled touch is one the browser synthesized anyway: ignore it. */
	const GHOST_CLICK_MS = 600;

	const lastTap = { ctrl: 0, alt: 0 };

	function toggle(which: "ctrl" | "alt", e: Event) {
		const now = e.timeStamp;
		const doubleTap = now - lastTap[which] < DOUBLE_TAP_MS;
		lastTap[which] = now;
		if (which === "ctrl") ctrl = nextModState(ctrl, doubleTap);
		else alt = nextModState(alt, doubleTap);
	}

	/**
	 * Runs `run` when the key is pressed, without ever moving focus. pointerdown is cancelled, so the terminal's
	 * textarea (and with it the iOS keyboard) keeps focus. A touch fires on pointerup and cancels its touchend:
	 * iOS then synthesizes no mouse events or click for the tap, which on a quick second tap counted as a
	 * double-tap and dismissed the keyboard. A touch that turns into scrolling the row (pointercancel) or lifts
	 * outside the key fires nothing. Mouse and keyboard activation go through click. `repeat` keys fire again
	 * every REPEAT_EVERY_MS while held.
	 */
	function key(run: (e: Event) => void, repeat = false): Attachment<HTMLButtonElement> {
		return (node) => {
			let touch: number | null = null;
			let lastTouch = -Infinity;
			let repeated = false;
			let delay: number | undefined;
			let timer: number | undefined;
			const stop = () => {
				clearTimeout(delay);
				clearInterval(timer);
			};
			const down = (e: PointerEvent) => {
				e.preventDefault();
				if (node.disabled) return;
				touch = e.pointerType === "touch" ? e.pointerId : null;
				repeated = false;
				stop();
				if (!repeat) return;
				delay = window.setTimeout(() => {
					repeated = true;
					run(e);
					timer = window.setInterval(() => run(e), REPEAT_EVERY_MS);
				}, REPEAT_DELAY_MS);
			};
			const up = (e: PointerEvent) => {
				stop();
				if (e.pointerId !== touch) return;
				touch = null;
				lastTouch = e.timeStamp;
				const r = node.getBoundingClientRect();
				const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
				if (inside && !repeated && !node.disabled) run(e);
			};
			const cancel = () => {
				stop();
				touch = null;
			};
			const touchend = (e: TouchEvent) => {
				if (e.cancelable) e.preventDefault();
			};
			const click = (e: MouseEvent) => {
				if (e.timeStamp - lastTouch < GHOST_CLICK_MS) return;
				if (repeated) repeated = false;
				else run(e);
			};
			node.addEventListener("pointerdown", down);
			node.addEventListener("pointerup", up);
			node.addEventListener("pointercancel", cancel);
			node.addEventListener("pointerleave", stop);
			node.addEventListener("touchend", touchend, { passive: false });
			node.addEventListener("click", click);
			return () => {
				stop();
				node.removeEventListener("pointerdown", down);
				node.removeEventListener("pointerup", up);
				node.removeEventListener("pointercancel", cancel);
				node.removeEventListener("pointerleave", stop);
				node.removeEventListener("touchend", touchend);
				node.removeEventListener("click", click);
			};
		};
	}

	const SIMPLE: Array<{ label: string; seq: string }> = [
		{ label: "|", seq: "|" },
		{ label: "~", seq: "~" },
		{ label: "/", seq: "/" },
		{ label: "-", seq: "-" },
	];
	const ARROWS: Array<{ label: string; seq: string; aria: string }> = [
		{ label: "←", seq: KEY_SEQ.left, aria: "Left" },
		{ label: "↑", seq: KEY_SEQ.up, aria: "Up" },
		{ label: "↓", seq: KEY_SEQ.down, aria: "Down" },
		{ label: "→", seq: KEY_SEQ.right, aria: "Right" },
	];
</script>

<!-- One root across both modes, so the entry animation plays when the row appears, not on a mode switch. -->
<div class="keys" role="toolbar" aria-label={selecting ? "Text selection" : "Extra keys"}>
	{#if selecting}
		<button class="key copy" disabled={!hasSelection || copied} {@attach key(() => oncopy())}>
			<Icon icon={copied ? Icons.Check : Icons.Copy} />
			{copied ? "Copied" : "Copy"}
		</button>
		<button class="key" disabled={!hasText} {@attach key(() => onselectall())}>Select all</button>
		<button class="key" disabled={!canPaste} {@attach key(() => onpaste())}>Paste</button>
		<button class="key" {@attach key(() => ondone())}>Done</button>
	{:else}
		<button class="key" {@attach key(() => onkey(KEY_SEQ.esc))}>Esc</button>
		<button class="key" {@attach key(() => onkey(KEY_SEQ.tab))}>Tab</button>
		<button class="key" aria-pressed={ctrl !== "off"} data-mod={ctrl} {@attach key((e) => toggle("ctrl", e))}>Ctrl</button>
		<button class="key" aria-pressed={alt !== "off"} data-mod={alt} {@attach key((e) => toggle("alt", e))}>Alt</button>
		<button class="key" {@attach key(() => onselect())}>Select</button>
		<button class="key" disabled={!canPaste} {@attach key(() => onpaste())}>Paste</button>
		{#each ARROWS as a (a.seq)}
			<button class="key" aria-label={a.aria} {@attach key(() => onkey(a.seq), true)}>{a.label}</button>
		{/each}
		{#each SIMPLE as k (k.seq)}
			<button class="key" {@attach key(() => onkey(k.seq))}>{k.label}</button>
		{/each}
		<button class="key" aria-label="Hide keyboard" {@attach key(() => onhide())}>
			<Icon icon={Icons.HideKeyboard} />
		</button>
	{/if}
</div>

<style>
	.keys {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		height: var(--extrakeys-h);
		padding: 0 var(--sp-1);
		background: var(--surface-2);
		border-block-start: var(--border);
		overflow-x: auto;
		scroll-snap-type: x proximity;
		scrollbar-width: none;
		/* Only the row's own sideways scroll: a vertical drag must not move anything. */
		touch-action: pan-x;
		flex: none;
		animation: keys-in var(--dur-enter) var(--ease);
	}
	/* Rises out of its slot's bottom edge: the clip tracks the slide so nothing paints below the pane. */
	@keyframes keys-in {
		from {
			translate: 0 100%;
			clip-path: inset(0 0 100% 0);
			opacity: 0;
		}
	}
	.key {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--sp-1);
		flex: none;
		min-width: var(--key-min-w);
		height: calc(var(--extrakeys-h) - var(--sp-2));
		padding: 0 var(--sp-2);
		border-radius: var(--radius-sm);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--fg);
		white-space: nowrap;
		scroll-snap-align: start;
		user-select: none;
		-webkit-user-select: none;
		touch-action: pan-x;
		&:not([disabled]):active {
			background: var(--surface-3);
		}
		&[disabled] {
			opacity: 0.6;
			cursor: not-allowed;
		}
		&[aria-pressed="true"] {
			background: var(--accent-soft);
			color: var(--accent);
		}
		&[data-mod="locked"] {
			box-shadow: inset 0 calc(-1 * var(--edge-w)) 0 var(--accent);
		}
		&.copy:not([disabled]) {
			background: var(--accent-soft);
			color: var(--accent);
		}
	}
</style>
