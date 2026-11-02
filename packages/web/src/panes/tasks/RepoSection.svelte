<script lang="ts">
	import type { RepoInfo } from "@romp/protocol";
	import { Icons } from "../../lib/icons";
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
		expanded: boolean;
		ontoggle: () => void;
		onsettings: () => void;
		onagent: (agentId: string, cwd: string) => void;
	}

	let { repo, data, expanded, ontoggle, onsettings, onagent }: Props = $props();

	const id = $props.id();
	let landedOpen = $state(false);

	const groups = $derived(expanded ? groupTasks(data.tasksOf(repo.name)) : []);
</script>

<section class="repo">
	<div class="row">
		<IconButton size="sm" icon={Icons.Settings} label="Settings for {repo.name}" onclick={onsettings} />
		<h3>
			<button id="{id}-toggle" class="toggle" aria-expanded={expanded} aria-controls="{id}-panel" onclick={ontoggle}>
				<span class="name truncate">{repo.name}</span>
				<Chip icon={Icons.Branch}>{repo.branch}</Chip>
				<span class="remote meta mono truncate">{remoteLabel(repo.remote)}</span>
				<Icon icon={expanded ? Icons.ChevronDown : Icons.ChevronRight} size="sm" />
			</button>
		</h3>
	</div>

	{#if expanded}
		<div id="{id}-panel" class="panel" role="region" aria-labelledby="{id}-toggle">
			<NewTaskComposer {repo} {data} {onagent} />

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
		</div>
	{/if}
</section>

<style>
	.repo:not(:last-child) {
		border-block-end: var(--border);
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		min-width: 0;
		padding-block: var(--sp-1);
	}
	h3 {
		flex: 1;
		min-width: 0;
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		width: 100%;
		min-width: 0;
		min-height: var(--row-h);
		padding: 0 var(--sp-2);
		border-radius: var(--radius-md);
		transition: background var(--dur-fast);
		&:hover {
			background: var(--surface-3);
		}
		&:active {
			background: oklch(from var(--surface-3) calc(l + var(--active-l)) c h);
		}
		> :global(.icon) {
			color: var(--fg-muted);
		}
	}
	.name {
		flex: 0 1 auto;
		/* A long name still leaves the remote room for a few characters before its ellipsis. */
		max-width: 45%;
		font-weight: 600;
	}
	.remote {
		flex: 1 1 0;
	}
	.panel {
		display: grid;
		gap: var(--sp-2);
		padding-block: var(--sp-1) var(--sp-3);
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
