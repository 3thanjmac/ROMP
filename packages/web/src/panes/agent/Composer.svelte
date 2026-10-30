<script lang="ts">
	import { type BusySend, loadBusySend, loadDraft, saveBusySend, saveDraft } from "../../lib/agent/persist";
	import type { SendKind } from "../../lib/agent/types";
	import { Icons } from "../../lib/icons";
	import IconButton from "../../lib/ui/IconButton.svelte";
	import Segmented from "../../lib/ui/Segmented.svelte";

	interface Props {
		windowId: string;
		busy: boolean;
		/** The socket is live and the session loaded, so a send can go out now. */
		live: boolean;
		stopping: boolean;
		/** Touch keyboards: Enter inserts a newline and only the button sends. */
		coarse: boolean;
		/** Returns false when the message could not be sent; the text then stays in the field. */
		onsend: (kind: SendKind, text: string) => boolean;
		onstop: () => void;
	}

	let { windowId, busy, live, stopping, coarse, onsend, onstop }: Props = $props();

	// Each window keeps its own draft; the pane is keyed by window, so the id never changes under this component.
	// svelte-ignore state_referenced_locally
	let text = $state(loadDraft(windowId));
	// svelte-ignore state_referenced_locally
	let busySend = $state<BusySend>(loadBusySend(windowId));
	let field: HTMLTextAreaElement;

	const empty = $derived(text.trim() === "");
	const sendLabel = $derived(!live ? "Offline, reconnecting" : busy && busySend === "follow_up" ? "Send after this turn" : "Send");
	const placeholder = $derived(!busy ? "Ask the agent…" : busySend === "steer" ? "Steer the agent…" : "Queue a message for after this turn…");

	const OPTIONS = [
		{ value: "steer", label: "Steer now" },
		{ value: "follow_up", label: "After this turn" },
	] satisfies { value: BusySend; label: string }[];

	$effect(() => saveDraft(windowId, text));

	function submit() {
		if (empty || !live) return;
		if (onsend(busy ? busySend : "prompt", text.trim())) text = "";
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.isComposing) return;
		if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !coarse) {
			e.preventDefault();
			submit();
		} else if (e.key === "Escape" && busy && empty && !stopping) {
			e.preventDefault();
			onstop();
		}
	}

	export function focus(): void {
		field.focus();
	}

	/** Puts a message that did not go through back, ahead of anything typed since. */
	export function restore(message: string): void {
		text = text.trim() ? `${message}\n\n${text}` : message;
	}

	/** Extension `set_editor_text`. */
	export function setText(next: string): void {
		text = next;
	}
</script>

<div class="composer">
	{#if busy}
		<div class="when">
			<Segmented options={OPTIONS} bind:value={busySend} label="When to deliver" onchange={v => saveBusySend(windowId, v)} />
		</div>
	{/if}
	<div class="row">
		<textarea
			bind:this={field}
			bind:value={text}
			{placeholder}
			aria-label="Message to the agent"
			rows="1"
			enterkeyhint={coarse ? "enter" : "send"}
			{onkeydown}
		></textarea>
		{#if busy}
			<IconButton
				label={stopping ? "Stopping…" : "Stop"}
				icon={stopping ? Icons.Spinner : Icons.Stop}
				spin={stopping}
				variant="danger"
				disabled={stopping || !live}
				onclick={onstop}
			/>
		{/if}
		<IconButton label={sendLabel} icon={Icons.Send} variant="primary" disabled={empty || !live} onclick={submit} />
	</div>
</div>

<style>
	.composer {
		display: grid;
		gap: var(--sp-2);
		padding: var(--sp-2) var(--sp-3);
		background: var(--surface-2);
		border-block-start: var(--border);
		flex: none;
	}
	.when {
		display: flex;
	}
	.when,
	.row {
		max-width: var(--chat-measure);
		width: 100%;
		margin-inline: auto;
	}
	.row {
		display: flex;
		align-items: flex-end;
		gap: var(--sp-2);
	}
	textarea {
		flex: 1;
		min-width: 0;
		resize: none;
		field-sizing: content;
		min-height: calc(1lh + var(--sp-2) * 2 + 2px);
		max-height: calc(var(--composer-max-h) + var(--sp-2) * 2 + 2px);
		overflow-y: auto;
		line-height: 1.43;
	}
</style>
