<script lang="ts">
	import { clampRatio, RATIO_STEP, type SplitInfo } from "./layout";
	import { shell } from "./shell.svelte";

	interface Props {
		split: SplitInfo;
		/** The tile track element; split rects are fractions of its box. */
		track: HTMLElement;
	}

	let { split, track }: Props = $props();

	let dragging = $state(false);
	const row = $derived(split.dir === "row");

	/** Split extent in px along its axis, for the 120px minimum pane size. */
	function extentPx(): number {
		const box = track.getBoundingClientRect();
		return row ? split.rect.w * box.width : split.rect.h * box.height;
	}

	function ratioAt(e: PointerEvent): number {
		const box = track.getBoundingClientRect();
		const r = split.rect;
		const raw = row
			? ((e.clientX - box.left) / box.width - r.x) / r.w
			: ((e.clientY - box.top) / box.height - r.y) / r.h;
		return clampRatio(raw, extentPx());
	}

	function down(e: PointerEvent) {
		if (e.button !== 0) return;
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		dragging = true;
	}

	function move(e: PointerEvent) {
		if (dragging) shell.setRatio(split.path, ratioAt(e));
	}

	function up() {
		dragging = false;
	}

	function key(e: KeyboardEvent) {
		const back = row ? "ArrowLeft" : "ArrowUp";
		const fwd = row ? "ArrowRight" : "ArrowDown";
		if (e.key !== back && e.key !== fwd) return;
		e.preventDefault();
		const next = split.ratio + (e.key === fwd ? RATIO_STEP : -RATIO_STEP);
		shell.setRatio(split.path, clampRatio(Math.round(next * 100) / 100, extentPx()));
	}
</script>

<!-- A focusable separator is an interactive widget (WAI-ARIA window splitter). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	class="handle"
	class:row
	class:dragging
	role="separator"
	aria-orientation={row ? "vertical" : "horizontal"}
	aria-valuenow={Math.round(split.ratio * 100)}
	aria-valuemin={15}
	aria-valuemax={85}
	aria-label="Resize split"
	tabindex="0"
	style:--x={split.rect.x}
	style:--y={split.rect.y}
	style:--w={split.rect.w}
	style:--h={split.rect.h}
	style:--ratio={split.ratio}
	onpointerdown={down}
	onpointermove={move}
	onpointerup={up}
	onpointercancel={up}
	ondblclick={() => shell.setRatio(split.path, 0.5)}
	onkeydown={key}
>
	<span class="grip" aria-hidden="true"></span>
</div>

<style>
	/* The track is one --pane-gap larger than the desk on the right and bottom; panes subtract that gap, so
	   the gutter between two panes sits just before the split position. */
	.handle {
		position: absolute;
		z-index: var(--z-split);
		display: grid;
		place-items: center;
		touch-action: none;
		&::before {
			content: "";
			position: absolute;
			background: var(--line);
			transition: background var(--dur-fast);
		}
		&:hover::before,
		&.dragging::before,
		&:focus-visible::before {
			background: var(--accent);
		}
		&.row {
			left: calc((var(--x) + var(--w) * var(--ratio)) * 100% - var(--pane-gap) / 2);
			top: calc(var(--y) * 100%);
			width: var(--split-hit);
			height: calc(var(--h) * 100% - var(--pane-gap));
			translate: -50% 0;
			cursor: col-resize;
			&::before {
				width: 1px;
				inset-block: 0;
			}
		}
		&:not(.row) {
			top: calc((var(--y) + var(--h) * var(--ratio)) * 100% - var(--pane-gap) / 2);
			left: calc(var(--x) * 100%);
			height: var(--split-hit);
			width: calc(var(--w) * 100% - var(--pane-gap));
			translate: 0 -50%;
			cursor: row-resize;
			&::before {
				height: 1px;
				inset-inline: 0;
			}
		}
	}
	.grip {
		display: none;
		position: relative;
		border-radius: var(--radius-full);
		background: var(--line-strong);
	}
	@media (pointer: coarse) {
		.grip {
			display: block;
		}
		.row .grip {
			width: var(--split-grip-w);
			height: var(--split-grip-h);
		}
		:not(.row) > .grip {
			width: var(--split-grip-h);
			height: var(--split-grip-w);
		}
	}
</style>
