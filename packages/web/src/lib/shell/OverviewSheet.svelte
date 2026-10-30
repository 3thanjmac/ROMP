<script lang="ts">
	import { Icons } from "../icons";
	import EmptyState from "../ui/EmptyState.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import Sheet from "../ui/Sheet.svelte";
	import OverviewRow from "./OverviewRow.svelte";
	import { shell } from "./shell.svelte";
	import { frameUi } from "./ui.svelte";

	const ws = $derived(shell.active);

	let list = $state<HTMLElement>();
	let drag: { id: string; pointer: number; y0: number; dy: number; rowH: number; from: number } | null = $state(null);

	function grip(id: string, e: PointerEvent) {
		const rowEl = (e.currentTarget as HTMLElement).closest("li");
		if (!rowEl) return;
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		const gap = list ? parseFloat(getComputedStyle(list).rowGap) || 0 : 0;
		drag = {
			id,
			pointer: e.pointerId,
			y0: e.clientY,
			dy: 0,
			rowH: rowEl.offsetHeight + gap,
			from: ws.windows.findIndex((w) => w.id === id),
		};
		const target = e.currentTarget as HTMLElement;
		const move = (ev: PointerEvent) => {
			if (drag && ev.pointerId === drag.pointer) drag.dy = ev.clientY - drag.y0;
		};
		const up = (ev: PointerEvent) => {
			if (!drag || ev.pointerId !== drag.pointer) return;
			const to = Math.max(0, Math.min(ws.windows.length - 1, drag.from + Math.round(drag.dy / drag.rowH)));
			if (to !== drag.from) shell.reorder(drag.id, to);
			drag = null;
			target.removeEventListener("pointermove", move);
			target.removeEventListener("pointerup", up);
			target.removeEventListener("pointercancel", up);
		};
		target.addEventListener("pointermove", move);
		target.addEventListener("pointerup", up);
		target.addEventListener("pointercancel", up);
	}

	/** Where each row should be drawn while one row is dragged: the dragged row follows the finger, the rows it
	 *  passes shift by one slot to make room. */
	function offset(index: number, id: string): number {
		if (!drag) return 0;
		if (id === drag.id) return drag.dy;
		const to = drag.from + Math.round(drag.dy / drag.rowH);
		if (drag.from < index && index <= to) return -drag.rowH;
		if (to <= index && index < drag.from) return drag.rowH;
		return 0;
	}
</script>

<Sheet bind:open={frameUi.overview} label="Overview" full>
	{#snippet header()}
		<div class="workspaces" role="tablist" aria-label="Workspaces">
			{#each shell.state.workspaces as w (w.id)}
				<button role="tab" class="chip" aria-selected={w.id === ws.id} onclick={() => shell.switchWorkspace(w.id)}>
					<span class="truncate">{w.name}</span>
					<span class="meta tabular">{w.windows.length}</span>
				</button>
			{/each}
			<IconButton size="sm" label="New workspace" icon={Icons.Add} onclick={() => shell.addWorkspace()} />
		</div>
	{/snippet}
	{#if ws.windows.length === 0}
		<EmptyState icon={Icons.Overview} title="No windows here" text="Open a terminal, an agent or files to start.">
			{#snippet actions()}
				<IconButton
					variant="primary"
					label="New window"
					icon={Icons.Add}
					onclick={() => ((frameUi.overview = false), (frameUi.launcher = true))}
				/>
			{/snippet}
		</EmptyState>
	{:else}
		<ul class="list" bind:this={list}>
			{#each ws.windows as win, i (win.id)}
				<OverviewRow
					{win}
					focused={win.id === ws.focusedId}
					dragY={offset(i, win.id)}
					onpick={() => {
						shell.focus(win.id);
						frameUi.overview = false;
					}}
					onclose={() => shell.close(win.id)}
					ongrip={(e) => grip(win.id, e)}
				/>
			{/each}
		</ul>
	{/if}
</Sheet>

<style>
	.workspaces {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		overflow-x: auto;
		scroll-snap-type: x proximity;
		scroll-padding-inline: var(--sp-2);
		scrollbar-width: none;
		> * {
			scroll-snap-align: start;
		}
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-2);
		flex: none;
		max-width: var(--crumb-max);
		min-height: var(--tap);
		padding: 0 var(--sp-3);
		border-radius: var(--radius-full);
		border: var(--border);
		color: var(--fg-muted);
		font-weight: 500;
		&[aria-selected="true"] {
			background: var(--surface-3);
			color: var(--fg);
			border-color: var(--line-strong);
		}
	}
	.list {
		display: grid;
		gap: var(--sp-2);
		padding: 0;
	}
</style>
