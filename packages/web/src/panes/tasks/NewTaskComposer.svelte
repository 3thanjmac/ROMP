<script lang="ts">
	import { autoTitle, type LandMode, type ModelChoice, type RepoInfo } from "@romp/protocol";
	import { api, errorMessage } from "../../lib/api";
	import { Icons } from "../../lib/icons";
	import ThinkingButton from "../../lib/shell/ThinkingButton.svelte";
	import AsyncButton from "../../lib/ui/AsyncButton.svelte";
	import Button from "../../lib/ui/Button.svelte";
	import Segmented from "../../lib/ui/Segmented.svelte";
	import type { TasksData } from "./tasksData.svelte";

	interface Props {
		repo: RepoInfo;
		data: TasksData;
		/** Opens the new agent next to the tasks window. */
		onagent: (agentId: string, cwd: string) => void;
	}

	let { repo, data, onagent }: Props = $props();

	const STEP_MS = 2000;

	let prompt = $state("");
	let error: string | null = $state(null);
	let pendingLabel = $state("Creating worktree…");
	let touched = $state(false);
	/** Kept across tasks: the next task likely wants the same model. */
	let thinking = $state<ModelChoice>({ model: null, level: null });
	let form = $state<HTMLFormElement | null>(null);

	const hasDraft = $derived(prompt.trim() !== "");

	const landOptions = $derived([
		{ value: "push" as LandMode, label: `Push to ${repo.branch}`, icon: Icons.LandPush },
		{ value: "pr" as LandMode, label: "Pull request", icon: Icons.LandPr },
	]);

	function clear() {
		prompt = "";
		touched = false;
		error = null;
	}

	async function start() {
		touched = true;
		const text = prompt.trim();
		if (!text) return;
		error = null;
		pendingLabel = "Creating worktree…";
		const step = window.setTimeout(() => (pendingLabel = "Starting agent…"), STEP_MS);
		try {
			const created = await api.tasks.create({
				repo: repo.name,
				title: autoTitle(text),
				prompt: text,
				autoTitle: true,
				...(thinking.model || thinking.level ? { thinking } : {}),
			});
			data.tasks = [...data.tasks, created.task];
			if (created.agent) onagent(created.agent.id, created.agent.cwd);
			void data.load();
			clear();
		} catch (err) {
			error = errorMessage(err);
		} finally {
			clearTimeout(step);
		}
	}
</script>

<form class="composer" bind:this={form} onsubmit={(e) => e.preventDefault()}>
	<label>
		What should the agent do?
		<textarea
			bind:value={prompt}
			required
			rows="3"
			aria-invalid={touched && !prompt.trim()}
			placeholder="Describe the change..."
		></textarea>
	</label>
	{#if error}<p class="field-error">{error}</p>{/if}
	<div class="actions">
		<div class="land">
			<Segmented
				label="Landing mode for {repo.name}"
				options={landOptions}
				value={repo.land}
				onchange={(land) => data.setLand(repo, land)}
			/>
			<ThinkingButton
				value={thinking}
				allowDefault
				onchange={(choice) => (thinking = choice)}
				placement="bottom-start"
				phoneAnchor={form}
			/>
		</div>
		<div class="buttons">
			{#if hasDraft}<Button variant="ghost" onclick={clear}>Cancel</Button>{/if}
			<AsyncButton variant="primary" action={start} {pendingLabel}>Start task</AsyncButton>
		</div>
	</div>
</form>

<style>
	.composer {
		display: grid;
		gap: var(--sp-3);
		padding: var(--sp-3);
		background: var(--surface-2);
		border: var(--border);
		border-radius: var(--radius-lg);
	}
	textarea {
		min-height: var(--task-field-min-h);
		max-height: var(--field-max-h);
	}
	.land {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
	}
	.actions {
		container-type: inline-size;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-2);
	}
	.buttons {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		margin-inline-start: auto;
	}
	/* Too narrow for the labelled landing toggle beside the buttons: collapse it to icons (labels move to tooltips). */
	@container (width < 440px) {
		.land {
			--seg-label-display: none;
		}
	}
</style>
