<script lang="ts">
	import type { LandMode, RepoInfo } from "@romp/protocol";
	import { Icons } from "../../lib/icons";
	import Button from "../../lib/ui/Button.svelte";
	import Chip from "../../lib/ui/Chip.svelte";
	import Icon from "../../lib/ui/Icon.svelte";
	import Segmented from "../../lib/ui/Segmented.svelte";
	import { GROUP_LABEL, groupTasks } from "./group";
	import NewTaskComposer from "./NewTaskComposer.svelte";
	import TaskRow from "./TaskRow.svelte";
	import { taskKey, type TasksData } from "./tasksData.svelte";

	interface Props {
		repo: RepoInfo;
		data: TasksData;
		onagent: (agentId: string, cwd: string) => void;
	}

	let { repo, data, onagent }: Props = $props();

	const SAVED_MS = 2000;

	let composing = $state(false);
	let landedOpen = $state(false);
	let saved = $state(false);
	let savedTimer: number | undefined;

	const tasks = $derived(data.tasksOf(repo.name));
	const groups = $derived(groupTasks(tasks));
	const remoteHost = $derived.by(() => {
		if (!repo.remote) return "hub only";
		const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:](.+?)(?:\.git)?$/i.exec(repo.remote);
		return m ? `${m[1]}/${m[2]}` : repo.remote;
	});

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
</script>

<section class="repo">
	<header class="head">
		<div class="name">
			<h3 class="truncate">{repo.name}</h3>
			<span class="meta mono truncate">{remoteHost}</span>
			<Chip>{repo.branch}</Chip>
		</div>
		<div class="actions">
			{#if saved}<span class="meta saved" role="status">Saved</span>{/if}
			<Segmented label="Landing mode for {repo.name}" options={landOptions} value={repo.land} onchange={setLand} />
			{#if tasks.length > 0 && !composing}
				<Button size="sm" variant="primary" icon={Icons.Add} onclick={() => (composing = true)}>New task</Button>
			{/if}
		</div>
	</header>

	{#if composing || tasks.length === 0}
		<NewTaskComposer
			{repo}
			{data}
			{onagent}
			oncancel={tasks.length > 0 ? () => (composing = false) : undefined}
			ondone={() => (composing = false)}
		/>
	{/if}

	{#each groups as g (g.group)}
		<div class="group">
			{#if g.group === "landed"}
				<button class="group-head" aria-expanded={landedOpen} onclick={() => (landedOpen = !landedOpen)}>
					<Icon icon={landedOpen ? Icons.ChevronDown : Icons.ChevronRight} size="sm" />
					<h4>{GROUP_LABEL.landed}</h4>
					<span class="meta tabular">{g.tasks.length}</span>
				</button>
			{:else}
				<div class="group-head">
					<h4>{GROUP_LABEL[g.group]}</h4>
					<span class="meta tabular">{g.tasks.length}</span>
				</div>
			{/if}
			{#if g.group !== "landed" || landedOpen}
				<ul>
					{#each g.tasks as task (taskKey(task))}
						<TaskRow {task} {repo} {data} />
					{/each}
				</ul>
			{/if}
		</div>
	{/each}
</section>

<style>
	.repo {
		display: grid;
		gap: var(--sp-2);
		padding-block: var(--sp-3);
		&:not(:last-child) {
			border-block-end: var(--border);
		}
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--sp-2) var(--sp-3);
	}
	.name {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-width: 0;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
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
	.group {
		display: grid;
		gap: var(--sp-1);
	}
	.group-head {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: var(--sp-2) var(--sp-1) 0;
		color: var(--fg-muted);
		h4 {
			color: var(--fg-muted);
		}
	}
	button.group-head:hover h4 {
		color: var(--fg);
	}
	ul {
		padding: 0;
	}
</style>
