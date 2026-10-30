<script lang="ts">
	import type { RepoInfo, TaskInfo } from "@romp/protocol";
	import { errorMessage } from "../../lib/api";
	import { Icons } from "../../lib/icons";
	import AsyncButton from "../../lib/ui/AsyncButton.svelte";
	import Button from "../../lib/ui/Button.svelte";
	import Dialog from "../../lib/ui/Dialog.svelte";
	import Icon from "../../lib/ui/Icon.svelte";
	import IconButton from "../../lib/ui/IconButton.svelte";
	import Menu from "../../lib/ui/Menu.svelte";
	import MenuItem from "../../lib/ui/MenuItem.svelte";
	import TaskStatusChip from "../../lib/ui/TaskStatusChip.svelte";
	import { toast } from "../../lib/ui/toast.svelte";
	import { tooltip } from "../../lib/ui/tooltip";
	import type { TasksData } from "./tasksData.svelte";

	let { task, repo, data }: { task: TaskInfo; repo: RepoInfo; data: TasksData } = $props();

	let showLog = $state(false);
	let confirmDelete = $state(false);
	let deleteError: string | null = $state(null);

	const conflictLine = $derived.by(() => {
		const files = task.conflictFiles;
		if (files.length === 0) return "";
		const shown = files.slice(0, 2).join(", ");
		return `${files.length} conflicted ${files.length === 1 ? "file" : "files"}: ${shown}${files.length > 2 ? "…" : ""}`;
	});

	async function remove() {
		deleteError = null;
		try {
			await data.remove(task);
			confirmDelete = false;
			toast({ message: `Deleted ${task.title}` });
		} catch (err) {
			deleteError = errorMessage(err);
		}
	}
</script>

<li class="task">
	<div class="row">
		<div class="left">
			<div class="line">
				<TaskStatusChip status={task.status} />
				<span class="title truncate">{task.title}</span>
			</div>
			{#if task.status === "conflict" && conflictLine}
				<span class="meta truncate">{conflictLine}</span>
			{:else if (task.status === "queued" || task.status === "landing") && task.landing?.message}
				<span class="meta truncate">{task.landing.message}</span>
			{:else}
				<span class="meta mono truncate">{task.branch}</span>
			{/if}
		</div>
		<div class="right tabular">
			{#if task.ahead > 0}
				<span class="count meta" role="img" aria-label="{task.ahead} commits ahead" use:tooltip>
					<Icon icon={Icons.Ahead} size="xs" />{task.ahead}
				</span>
			{/if}
			{#if task.behind > 0}
				<span class="count meta" role="img" aria-label="{task.behind} commits behind" use:tooltip>
					<Icon icon={Icons.Behind} size="xs" />{task.behind}
				</span>
			{/if}
			{#if task.dirty}
				<span class="dirty" role="img" aria-label="Uncommitted changes" use:tooltip></span>
			{/if}
			{#if task.status === "active"}
				<Button
					size="sm"
					variant="primary"
					icon={Icons.Ship}
					disabledReason={task.ahead === 0 && !task.dirty ? "Nothing to ship yet" : null}
					onclick={() => data.ship(task, repo.branch)}
				>
					Ship
				</Button>
			{:else if task.status === "conflict"}
				<AsyncButton size="sm" variant="secondary" icon={Icons.Agent} action={() => data.openAgent(task)}>
					Resolve with agent
				</AsyncButton>
			{:else if task.status === "failed"}
				<Button size="sm" variant="secondary" aria-expanded={showLog} onclick={() => (showLog = !showLog)}>View log</Button>
			{:else if task.status === "landed"}
				{#if task.landing?.prUrl}
					<a class="pr" href={task.landing.prUrl} target="_blank" rel="noopener">
						Pull request <Icon icon={Icons.External} size="xs" />
					</a>
				{:else if task.landing?.commit}
					<span class="meta mono">{task.landing.commit.slice(0, 7)}</span>
				{/if}
			{/if}
			<Menu label="Task actions" placement="bottom-end">
				{#snippet trigger(props)}
					<IconButton {...props} size="sm" label="Task actions" icon={Icons.More} />
				{/snippet}
				<MenuItem icon={Icons.Agent} onselect={() => void data.openAgent(task)}>Open agent</MenuItem>
				<MenuItem icon={Icons.Terminal} onselect={() => data.openTerminal(task)}>Open terminal here</MenuItem>
				<MenuItem icon={Icons.Files} onselect={() => data.openFiles(task)}>Open files here</MenuItem>
				<MenuItem icon={Icons.Trash} danger onselect={() => ((deleteError = null), (confirmDelete = true))}>Delete task</MenuItem>
			</Menu>
		</div>
	</div>
	{#if showLog && task.status === "failed"}
		<div class="log">
			<p class="log-title">{task.landing?.message ?? "The merge queue rejected this task."}</p>
			{#if task.landing?.log}<pre>{task.landing.log}</pre>{/if}
			<div class="log-actions">
				<AsyncButton size="sm" variant="secondary" icon={Icons.Agent} action={() => data.openAgent(task)}>Open agent</AsyncButton>
				<Button size="sm" variant="primary" icon={Icons.Ship} onclick={() => data.ship(task, repo.branch)}>Retry ship</Button>
			</div>
		</div>
	{/if}
</li>

<Dialog bind:open={confirmDelete} title="Delete {task.title}?">
	<p class="muted">Removes the worktree and branch <span class="mono">{task.branch}</span>. Unshipped commits are lost.</p>
	{#if deleteError}<p class="field-error">{deleteError}</p>{/if}
	{#snippet footer()}
		<Button onclick={() => (confirmDelete = false)}>Cancel</Button>
		<AsyncButton variant="danger" action={remove} pendingLabel="Deleting…">Delete task</AsyncButton>
	{/snippet}
</Dialog>

<style>
	.task {
		list-style: none;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-3);
		min-height: calc(var(--row-h) + var(--sp-2));
		padding: var(--sp-1) var(--sp-2) var(--sp-1) var(--sp-3);
		border-radius: var(--radius-md);
		transition: background var(--dur-fast);
		&:hover {
			background: var(--surface-3);
		}
	}
	.left {
		display: grid;
		gap: var(--sp-1);
		min-width: 0;
		flex: 1;
	}
	.line {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-width: 0;
	}
	.title {
		font-weight: 500;
	}
	.right {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		flex: none;
	}
	.count {
		display: inline-flex;
		align-items: center;
		gap: 1px;
	}
	.dirty {
		width: var(--dot-sm);
		height: var(--dot-sm);
		border-radius: var(--radius-full);
		background: var(--warning);
	}
	.pr {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		font-size: var(--text-sm);
	}
	.log {
		display: grid;
		gap: var(--sp-2);
		margin: 0 var(--sp-2) var(--sp-2);
		padding: var(--sp-3);
		background: var(--inset);
		border-radius: var(--radius-md);
	}
	.log-title {
		font-weight: 600;
	}
	pre {
		font-size: var(--text-xs);
		max-height: 16lh;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.log-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
	}
</style>
