<script lang="ts">
	/**
	 * Overview list row. Tap focuses; a horizontal swipe left reveals Close and, released past 40% of the row
	 * width, closes the window (Undo toast); the grip drags the row to reorder.
	 */
	import type { WindowState } from "@romp/protocol";
	import { Icons, KIND_ICON } from "../icons";
	import Chip from "../ui/Chip.svelte";
	import ClientCount from "../ui/ClientCount.svelte";
	import ConnDot from "../ui/ConnDot.svelte";
	import Icon from "../ui/Icon.svelte";
	import Spinner from "../ui/Spinner.svelte";
	import { paneStatuses } from "./pane.svelte";
	import { displayTitle } from "./shell.svelte";

	interface Props {
		win: WindowState;
		focused: boolean;
		/** Vertical drag offset (px) while this row is being reordered. */
		dragY: number;
		onpick: () => void;
		onclose: () => void;
		ongrip: (e: PointerEvent) => void;
	}

	let { win, focused, dragY, onpick, onclose, ongrip }: Props = $props();

	const CLOSE_SHARE = 0.4;
	/** Horizontal travel (px) before a press becomes a swipe instead of a tap. */
	const SWIPE_SLOP = 8;

	const status = $derived(paneStatuses.get(win.id));
	let dx = $state(0);
	let springing = $state(false);
	let swipe: { id: number; x0: number; y0: number; active: boolean; cancelled: boolean } | null = null;
	let row: HTMLElement;
	/** A swipe just ended: swallow the click the browser may still deliver. */
	let swiped = false;

	function down(e: PointerEvent) {
		if ((e.target as Element).closest(".grip")) return;
		swipe = { id: e.pointerId, x0: e.clientX, y0: e.clientY, active: false, cancelled: false };
		swiped = false;
		springing = false;
	}

	function move(e: PointerEvent) {
		if (!swipe || e.pointerId !== swipe.id || swipe.cancelled) return;
		const ddx = e.clientX - swipe.x0;
		const ddy = e.clientY - swipe.y0;
		if (!swipe.active) {
			if (Math.abs(ddy) > SWIPE_SLOP && Math.abs(ddy) > Math.abs(ddx)) {
				swipe.cancelled = true;
				return;
			}
			if (Math.abs(ddx) < SWIPE_SLOP) return;
			swipe.active = true;
			row.setPointerCapture(e.pointerId);
		}
		dx = Math.min(0, ddx);
	}

	function up(e: PointerEvent) {
		if (!swipe || e.pointerId !== swipe.id) return;
		const wasSwipe = swipe.active;
		swipe = null;
		if (!wasSwipe) return;
		swiped = true;
		springing = true;
		if (-dx > row.offsetWidth * CLOSE_SHARE) onclose();
		dx = 0;
	}

	function click() {
		if (swiped) {
			swiped = false;
			return;
		}
		onpick();
	}
</script>

<li class="wrap" style:translate="0 {dragY}px" class:dragging={dragY !== 0}>
	{#if dx < 0}<div class="close-area" aria-hidden="true"><Icon icon={Icons.Close} />Close</div>{/if}
	<div
		class="row"
		class:focused
		class:springing
		style:translate="{dx}px 0"
		bind:this={row}
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={up}
		role="presentation"
	>
		<span class="grip" role="button" tabindex="-1" aria-label="Drag to reorder" data-sheet-nodrag onpointerdown={ongrip}>
			<Icon icon={Icons.Grip} />
		</span>
		<button class="main" onclick={click}>
			<Icon icon={KIND_ICON[win.kind]} />
			<span class="text">
				<span class="truncate title">{displayTitle(win)}</span>
				{#if status?.subtitle}<span class="meta mono truncate">{status.subtitle}</span>{/if}
			</span>
		</button>
		<span class="badges">
			{#if status?.needsInput}
				<Chip tone="warning" icon={Icons.Warn}>Needs input</Chip>
			{:else if status?.busy}
				<Spinner size="sm" label="Working" />
			{/if}
			{#if status?.conn}<ConnDot state={status.conn} exitCode={status.exitCode} />{/if}
			{#if status}<ClientCount count={status.clients} />{/if}
		</span>
	</div>
</li>

<style>
	.wrap {
		position: relative;
		list-style: none;
		border-radius: var(--radius-lg);
		overflow: hidden;
		&.dragging {
			z-index: var(--z-pane-focused);
			box-shadow: var(--shadow-md);
		}
	}
	.close-area {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--sp-2);
		padding-inline-end: var(--sp-4);
		background: var(--danger);
		color: var(--accent-fg);
		font-weight: 500;
	}
	.row {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		min-height: var(--overview-row-h);
		padding-inline: 0 var(--sp-3);
		background: var(--surface-2);
		border-radius: var(--radius-lg);
		touch-action: pan-y;
		&.focused {
			box-shadow: inset var(--edge-w) 0 0 var(--accent);
		}
		&.springing {
			transition: translate var(--dur-enter) var(--ease);
		}
	}
	.grip {
		display: inline-grid;
		place-items: center;
		width: var(--tap);
		align-self: stretch;
		color: var(--fg-subtle);
		touch-action: none;
		cursor: grab;
	}
	.main {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		flex: 1;
		min-width: 0;
		align-self: stretch;
		> :global(.icon) {
			color: var(--fg-muted);
		}
	}
	.text {
		display: grid;
		min-width: 0;
	}
	.title {
		font-weight: 500;
	}
	.badges {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		flex: none;
	}
</style>
