<script lang="ts">
	import type { ModelChoice } from "@romp/protocol";
	import { untrack } from "svelte";
	import { api, errorMessage } from "../api";
	import ThinkingButton from "./ThinkingButton.svelte";

	let { agentId }: { agentId: string | null } = $props();

	let choice = $state<ModelChoice | null>(null);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);
	/** Bumped per request and per agent change; only the latest answer lands. */
	let seq = 0;

	$effect.pre(() => {
		void agentId;
		untrack(() => {
			seq++;
			choice = null;
			error = null;
			busy = null;
		});
	});

	async function load(): Promise<void> {
		const id = agentId;
		if (!id) return;
		const mine = ++seq;
		if (!choice) busy = "Loading…";
		try {
			const current = await api.agents.thinking(id);
			if (mine !== seq) return;
			choice = current;
			error = null;
		} catch (err) {
			if (mine === seq) error = `Couldn't load the session's model. ${errorMessage(err)}`;
		} finally {
			if (mine === seq) busy = null;
		}
	}

	/** Optimistic: the wheels stay where the user left them, and roll back if OMP refuses. */
	async function change(next: ModelChoice) {
		const id = agentId;
		const prev = choice;
		if (!id || !prev) return;
		const modelChanged = next.model?.provider !== prev.model?.provider || next.model?.id !== prev.model?.id;
		const patch: ModelChoice = {
			model: modelChanged ? next.model : null,
			level: next.level !== prev.level ? next.level : null,
		};
		if (!patch.model && !patch.level) return;
		const mine = ++seq;
		choice = next;
		error = null;
		busy = "Switching…";
		try {
			const settled = await api.agents.setThinking(id, patch);
			if (mine === seq) choice = settled;
		} catch (err) {
			if (mine !== seq) return;
			choice = prev;
			error = `Couldn't switch. ${errorMessage(err)}`;
		} finally {
			if (mine === seq) busy = null;
		}
	}
</script>

<ThinkingButton
	size="bar"
	value={choice}
	onchange={(next) => void change(next)}
	onopen={() => void load()}
	{busy}
	{error}
	onretry={choice ? undefined : load}
	disabled={!agentId}
	disabledLabel="Model settings unavailable until the agent starts"
/>
