<script lang="ts">
	import { autoTitle, type LandMode, type RepoInfo } from "@romp/protocol";
	import { api, errorMessage } from "../../lib/api";
	import { Icons } from "../../lib/icons";
	import AsyncButton from "../../lib/ui/AsyncButton.svelte";
	import Button from "../../lib/ui/Button.svelte";
	import Segmented from "../../lib/ui/Segmented.svelte";
	import { TITLE_MAX } from "./group";
	import type { TasksData } from "./tasksData.svelte";

	interface Props {
		repo: RepoInfo;
		data: TasksData;
		/** Opens the new agent next to the tasks window. */
		onagent: (agentId: string, cwd: string) => void;
	}

	let { repo, data, onagent }: Props = $props();

	const STEP_MS = 2000;
	const SAVED_MS = 2000;
	/** Below this action-row width the landing toggle drops its labels so it stays beside Start task. */
	const COMPACT_LAND_PX = 440;

	let prompt = $state("");
	let title = $state("");
	let error: string | null = $state(null);
	let pendingLabel = $state("Creating worktree…");
	let touched = $state(false);
	let saved = $state(false);
	let savedTimer: number | undefined;
	let actionsWidth = $state(0);

	const suggested = $derived(autoTitle(prompt));
	const hasDraft = $derived(prompt.trim() !== "" || title.trim() !== "");

	const landOptions = $derived([
		{ value: "push" as LandMode, label: `Push to ${repo.branch}`, icon: Icons.LandPush },
		{ value: "pr" as LandMode, label: "Pull request", icon: Icons.LandPr },
	]);

	async function setLand(land: LandMode) {
		clearTimeout(savedTimer);
		saved = false;
		if (await data.setLand(repo, land)) {
			saved = true;
			savedTimer = window.setTimeout(() => (saved = false), SAVED_MS);
		}
	}

	function clear() {
		prompt = "";
		title = "";
		touched = false;
		error = null;
	}

	async function start() {
		touched = true;
		const text = prompt.trim();
		if (!text) return;
		const typed = title.trim();
		error = null;
		pendingLabel = "Creating worktree…";
		const step = window.setTimeout(() => (pendingLabel = "Starting agent…"), STEP_MS);
		try {
			const created = await api.tasks.create({
				repo: repo.name,
				title: typed || autoTitle(text),
				prompt: text,
				autoTitle: !typed,
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
		<span>Title <span class="subtle">(optional)</span></span>
		<input bind:value={title} maxlength={TITLE_MAX} placeholder={suggested || "Generated from the prompt"} />
	</label>
	{#if error}<p class="field-error">{error}</p>{/if}
	<div class="actions" bind:clientWidth={actionsWidth}>
		<div class="land">
			<Segmented
				label="Landing mode for {repo.name}"
				options={landOptions}
				value={repo.land}
				iconOnly={actionsWidth > 0 && actionsWidth < COMPACT_LAND_PX}
				onchange={setLand}
			/>
			{#if saved}<span class="meta saved" role="status">Saved</span>{/if}
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
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-2);
	}
	.land,
	.buttons {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
	}
	.buttons {
		margin-inline-start: auto;
	}
	.saved {
		animation: fade var(--dur-enter) var(--ease);
	}
	@keyframes fade {
		from {
			opacity: 0;
		}
	}
</style>
