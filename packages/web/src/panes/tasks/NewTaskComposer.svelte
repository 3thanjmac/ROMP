<script lang="ts">
	import type { RepoInfo } from "@romp/protocol";
	import { api, errorMessage } from "../../lib/api";
	import AsyncButton from "../../lib/ui/AsyncButton.svelte";
	import Button from "../../lib/ui/Button.svelte";
	import { TITLE_MAX, titleFromPrompt } from "./group";
	import type { TasksData } from "./tasksData.svelte";

	interface Props {
		repo: RepoInfo;
		data: TasksData;
		/** Hidden when absent (the composer is always open for a repo without tasks). */
		oncancel?: () => void;
		ondone: () => void;
		/** Opens the new agent next to the tasks window. */
		onagent: (agentId: string, cwd: string) => void;
	}

	let { repo, data, oncancel, ondone, onagent }: Props = $props();

	const STEP_MS = 2000;

	let prompt = $state("");
	let title = $state("");
	let titleEdited = $state(false);
	let error: string | null = $state(null);
	let pendingLabel = $state("Creating worktree…");
	let touched = $state(false);

	$effect(() => {
		if (!titleEdited) title = titleFromPrompt(prompt);
	});

	async function start() {
		touched = true;
		if (!prompt.trim() || !title.trim()) return;
		error = null;
		pendingLabel = "Creating worktree…";
		const step = window.setTimeout(() => (pendingLabel = "Starting agent…"), STEP_MS);
		try {
			const created = await api.tasks.create({ repo: repo.name, title: title.trim(), prompt: prompt.trim() });
			data.tasks = [...data.tasks, created.task];
			if (created.agent) onagent(created.agent.id, created.agent.cwd);
			void data.load();
			prompt = "";
			title = "";
			titleEdited = false;
			touched = false;
			ondone();
		} catch (err) {
			error = errorMessage(err);
		} finally {
			clearTimeout(step);
		}
	}
</script>

<form class="composer" onsubmit={(e) => e.preventDefault()}>
	<label>
		What should the agent do?
		<textarea
			bind:value={prompt}
			required
			rows="3"
			aria-invalid={touched && !prompt.trim()}
			placeholder="Describe the change, e.g. Add a dark mode toggle to the settings page"
		></textarea>
	</label>
	<label>
		Title
		<input bind:value={title} required maxlength={TITLE_MAX} oninput={() => (titleEdited = true)} aria-invalid={touched && !title.trim()} />
	</label>
	{#if error}<p class="field-error">{error}</p>{/if}
	<div class="actions">
		{#if oncancel}<Button variant="ghost" onclick={oncancel}>Cancel</Button>{/if}
		<AsyncButton variant="primary" action={start} {pendingLabel}>Start task</AsyncButton>
	</div>
</form>

<style>
	.composer {
		display: grid;
		gap: var(--sp-3);
		padding: var(--sp-3);
		margin-block: var(--sp-2);
		background: var(--surface-2);
		border: var(--border);
		border-radius: var(--radius-lg);
	}
	textarea {
		min-height: var(--task-field-min-h);
		max-height: var(--field-max-h);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
	}
</style>
