<script lang="ts">
	import type { RepoInfo } from "@romp/protocol";
	import { Icons } from "../../lib/icons";
	import { repoColorVar } from "../../lib/repoColors.svelte";
	import Chip from "../../lib/ui/Chip.svelte";
	import Icon from "../../lib/ui/Icon.svelte";
	import IconButton from "../../lib/ui/IconButton.svelte";
	import { remoteLabel, repoCounts } from "./group";
	import type { TasksData } from "./tasksData.svelte";

	interface Props {
		repo: RepoInfo;
		data: TasksData;
		onopen: () => void;
		onsettings: () => void;
	}

	let { repo, data, onopen, onsettings }: Props = $props();

	const counts = $derived(repoCounts(data.tasksOf(repo.name)));
</script>

<li class="repo" style:--repo={repoColorVar(repo.color)}>
	<IconButton size="sm" icon={Icons.Settings} label="Settings for {repo.name}" onclick={onsettings} />
	<button class="open" onclick={onopen}>
		<span class="swatch" aria-hidden="true"></span>
		<span class="name truncate">{repo.name}</span>
		<Chip icon={Icons.Branch}>{repo.branch}</Chip>
		<span class="remote meta mono truncate">{remoteLabel(repo.remote)}</span>
		{#if counts.attention > 0}
			<Chip tone="warning" icon={Icons.Warn}>{counts.attention}</Chip>
		{/if}
		{#if counts.open > 0}
			<span class="meta tabular">{counts.open} open</span>
		{/if}
		<Icon icon={Icons.ChevronRight} size="sm" />
	</button>
</li>

<style>
	.repo {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		min-width: 0;
		padding-block: var(--sp-1);
		&:not(:last-child) {
			border-block-end: var(--border);
		}
	}
	.open {
		flex: 1;
		display: flex;
		align-items: center;
		gap: var(--sp-2);
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
	.swatch {
		flex: none;
		width: var(--icon-xs);
		height: var(--icon-xs);
		border-radius: var(--radius-xs);
		background: var(--repo);
	}
	.name {
		flex: 0 1 auto;
		/* A long name still leaves the remote room for a few characters before its ellipsis. */
		max-width: 45%;
		font-weight: 600;
		color: oklch(from var(--repo) max(l, var(--repo-text-min-l)) c h);
	}
	.remote {
		flex: 1 1 0;
	}
</style>
