<script lang="ts">
	import type { RepoInfo } from "@romp/protocol";
	import { Icons } from "../../lib/icons";
	import { repoColorVar } from "../../lib/repoColors.svelte";
	import Button from "../../lib/ui/Button.svelte";
	import Chip from "../../lib/ui/Chip.svelte";
	import Icon from "../../lib/ui/Icon.svelte";
	import IconButton from "../../lib/ui/IconButton.svelte";
	import { GROUP_LABEL, groupTasks, remoteLabel } from "./group";
	import NewTaskComposer from "./NewTaskComposer.svelte";
	import TaskRow from "./TaskRow.svelte";
	import { taskKey, type TasksData } from "./tasksData.svelte";

	interface Props {
		repo: RepoInfo;
		data: TasksData;
		onback: () => void;
		onsettings: () => void;
		onagent: (agentId: string, cwd: string) => void;
	}

	let { repo, data, onback, onsettings, onagent }: Props = $props();

	let landedOpen = $state(false);

	const groups = $derived(groupTasks(data.tasksOf(repo.name)));
</script>

<section class="page" style:--repo={repoColorVar(repo.color)}>
	<div class="bar">
		<Button variant="ghost" size="sm" icon={Icons.Back} onclick={onback}>Repos</Button>
		<IconButton size="sm" icon={Icons.Settings} label="Settings for {repo.name}" onclick={onsettings} />
	</div>
	<header class="head">
		<h2 class="truncate">{repo.name}</h2>
		<Chip icon={Icons.Branch}>{repo.branch}</Chip>
		<span class="remote meta mono truncate">{remoteLabel(repo.remote)}</span>
	</header>

	<NewTaskComposer {repo} {data} {onagent} />

	{#each groups as g (g.group)}
		<div class="group">
			{#if g.group === "landed"}
				<button class="group-head" aria-expanded={landedOpen} onclick={() => (landedOpen = !landedOpen)}>
					<Icon icon={landedOpen ? Icons.ChevronDown : Icons.ChevronRight} size="sm" />
					<h3>{GROUP_LABEL.landed}</h3>
					<span class="meta tabular">{g.tasks.length}</span>
				</button>
			{:else}
				<div class="group-head">
					<h3>{GROUP_LABEL[g.group]}</h3>
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
	.page {
		display: grid;
		gap: var(--sp-2);
	}
	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-2);
	}
	.head {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-width: 0;
		padding: var(--sp-1) var(--sp-1) var(--sp-2);
		border-block-end: var(--edge-w) solid var(--repo);
		h2 {
			flex: 0 1 auto;
			min-width: 0;
			color: oklch(from var(--repo) max(l, var(--repo-text-min-l)) c h);
		}
	}
	.remote {
		flex: 1 1 0;
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
		h3 {
			color: var(--fg-muted);
		}
	}
	button.group-head:hover h3 {
		color: var(--fg);
	}
	ul {
		padding: 0;
	}
</style>
