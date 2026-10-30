<script lang="ts">
	import type { AgentView } from "../../lib/agent/types";
	import { Icons } from "../../lib/icons";
	import Button from "../../lib/ui/Button.svelte";
	import AssistantMessage from "./AssistantMessage.svelte";
	import BusyLine from "./BusyLine.svelte";
	import NoticeRow from "./NoticeRow.svelte";
	import UserMessage from "./UserMessage.svelte";

	let { view, reducedMotion }: { view: AgentView; reducedMotion: boolean } = $props();

	/** Within this distance of the end counts as "at the bottom". */
	const SLACK_PX = 48;
	const QUEUED = { steer: "Queued: steer", follow_up: "Queued: after this turn", prompt: null } as const;

	let scroller: HTMLDivElement;
	let content: HTMLDivElement;
	/** Follow new output; cleared when the user scrolls up, set again at the bottom or via Jump to latest. */
	let pinned = $state(true);
	let lastTop = 0;

	/** Name of the tool executing right now, for the busy line. */
	const activeTool = $derived.by(() => {
		for (let i = view.items.length - 1; i >= 0; i--) {
			const item = view.items[i];
			if (item?.kind !== "assistant") continue;
			for (let b = item.blocks.length - 1; b >= 0; b--) {
				const block = item.blocks[b];
				if (block?.type === "tool" && view.tools[block.id]?.status === "running") return block.name;
			}
			return null;
		}
		return null;
	});

	function toBottom() {
		scroller.scrollTop = scroller.scrollHeight;
		lastTop = scroller.scrollTop;
	}

	function onscroll() {
		const top = scroller.scrollTop;
		// Growth never moves scrollTop up, so only a user scroll (or a shrink, which lands at the end) unpins.
		if (scroller.scrollHeight - top - scroller.clientHeight <= SLACK_PX) pinned = true;
		else if (top < lastTop) pinned = false;
		lastTop = top;
	}

	function jump() {
		pinned = true;
		scroller.scrollTo({ top: scroller.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
	}

	$effect(() => {
		toBottom();
		// Streaming text, expanding cards, loading images and the keyboard resizing the pane all land here.
		const observer = new ResizeObserver(() => {
			if (pinned) toBottom();
		});
		observer.observe(content);
		observer.observe(scroller);
		return () => observer.disconnect();
	});
</script>

<div class="wrap">
	<div class="scroller" bind:this={scroller} {onscroll}>
		<div class="column" bind:this={content}>
			{#each view.items as item (item.key)}
				{#if item.kind === "user"}
					<UserMessage text={item.text} images={item.images} note={item.steering ? "Steered" : null} />
				{:else if item.kind === "assistant"}
					<AssistantMessage {item} tools={view.tools} busy={view.busy} />
				{:else}
					<NoticeRow {item} />
				{/if}
			{/each}
			{#each view.queue.steering as text, i (`s${i}`)}
				<UserMessage {text} note={QUEUED.steer} pending />
			{/each}
			{#each view.queue.followUp as text, i (`f${i}`)}
				<UserMessage {text} note={QUEUED.follow_up} pending />
			{/each}
			{#each view.outbox as entry (entry.reqId)}
				<UserMessage text={entry.text} note={QUEUED[entry.kind]} pending />
			{/each}
			{#if view.busy && view.busySince !== null}
				<BusyLine since={view.busySince} activity={view.activity} tool={activeTool} />
			{/if}
		</div>
	</div>
	{#if !pinned}
		<div class="jump">
			<Button variant="secondary" size="sm" icon={Icons.JumpLatest} onclick={jump}>Latest</Button>
		</div>
	{/if}
</div>

<style>
	.wrap {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.scroller {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.column {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
		max-width: var(--chat-measure);
		margin-inline: auto;
		padding: var(--sp-4);
	}
	.jump {
		position: absolute;
		inset-inline: 0;
		bottom: var(--sp-3);
		display: flex;
		justify-content: center;
		pointer-events: none;
		z-index: var(--z-banner);
		:global(button) {
			pointer-events: auto;
			background: var(--surface-3);
			box-shadow: var(--shadow-md);
			border-radius: var(--radius-full);
		}
	}
</style>
