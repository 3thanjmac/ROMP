<script lang="ts">
	/**
	 * Touch key row under a focused terminal. pointerdown only prevents the focus loss (so the soft keyboard
	 * stays up); keys fire on click. Ctrl/Alt: tap latches for the next key, double-tap locks, tap again
	 * releases. Arrows repeat while held.
	 */
	import { Icons } from "../../lib/icons";
	import Icon from "../../lib/ui/Icon.svelte";
	import { KEY_SEQ, type ModState, nextModState } from "./keys";

	interface Props {
		ctrl: ModState;
		alt: ModState;
		/** Sends a key sequence through the modifier pipeline. */
		onkey: (seq: string) => void;
		onhide: () => void;
	}

	let { ctrl = $bindable(), alt = $bindable(), onkey, onhide }: Props = $props();

	const DOUBLE_TAP_MS = 300;
	const REPEAT_DELAY_MS = 400;
	const REPEAT_EVERY_MS = 50;

	const lastTap = { ctrl: 0, alt: 0 };

	function toggle(which: "ctrl" | "alt", e: MouseEvent) {
		const now = e.timeStamp;
		const doubleTap = now - lastTap[which] < DOUBLE_TAP_MS;
		lastTap[which] = now;
		if (which === "ctrl") ctrl = nextModState(ctrl, doubleTap);
		else alt = nextModState(alt, doubleTap);
	}

	let repeatDelay: number | undefined;
	let repeatTimer: number | undefined;
	let repeated = false;

	function keep(e: PointerEvent) {
		e.preventDefault();
	}

	function arrowDown(e: PointerEvent, seq: string) {
		e.preventDefault();
		repeated = false;
		stopRepeat();
		repeatDelay = window.setTimeout(() => {
			repeated = true;
			onkey(seq);
			repeatTimer = window.setInterval(() => onkey(seq), REPEAT_EVERY_MS);
		}, REPEAT_DELAY_MS);
	}

	function stopRepeat() {
		clearTimeout(repeatDelay);
		clearInterval(repeatTimer);
	}

	function arrowClick(seq: string) {
		if (!repeated) onkey(seq);
		repeated = false;
	}

	const SIMPLE: Array<{ label: string; seq: string; aria?: string }> = [
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

<div class="keys" role="toolbar" aria-label="Extra keys">
	<button class="key" onpointerdown={keep} onclick={() => onkey(KEY_SEQ.esc)}>Esc</button>
	<button class="key" onpointerdown={keep} onclick={() => onkey(KEY_SEQ.tab)}>Tab</button>
	<button
		class="key"
		aria-pressed={ctrl !== "off"}
		data-mod={ctrl}
		onpointerdown={keep}
		onclick={(e) => toggle("ctrl", e)}
	>
		Ctrl
	</button>
	<button class="key" aria-pressed={alt !== "off"} data-mod={alt} onpointerdown={keep} onclick={(e) => toggle("alt", e)}>
		Alt
	</button>
	{#each ARROWS as a (a.seq)}
		<button
			class="key"
			aria-label={a.aria}
			onpointerdown={(e) => arrowDown(e, a.seq)}
			onpointerup={stopRepeat}
			onpointercancel={stopRepeat}
			onpointerleave={stopRepeat}
			onclick={() => arrowClick(a.seq)}
		>
			{a.label}
		</button>
	{/each}
	{#each SIMPLE as k (k.seq)}
		<button class="key" onpointerdown={keep} onclick={() => onkey(k.seq)}>{k.label}</button>
	{/each}
	<button class="key" aria-label="Hide keyboard" onpointerdown={keep} onclick={onhide}>
		<Icon icon={Icons.HideKeyboard} />
	</button>
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
		flex: none;
	}
	.key {
		display: inline-grid;
		place-items: center;
		flex: none;
		min-width: var(--key-min-w);
		height: calc(var(--extrakeys-h) - var(--sp-2));
		padding: 0 var(--sp-2);
		border-radius: var(--radius-sm);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--fg);
		scroll-snap-align: start;
		user-select: none;
		-webkit-user-select: none;
		&:active {
			background: var(--surface-3);
		}
		&[aria-pressed="true"] {
			background: var(--accent-soft);
			color: var(--accent);
		}
		&[data-mod="locked"] {
			box-shadow: inset 0 calc(-1 * var(--edge-w)) 0 var(--accent);
		}
	}
</style>
