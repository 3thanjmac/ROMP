<script lang="ts">
	import { Icons } from "../../lib/icons";
	import type { PaneContext } from "../../lib/shell/pane.svelte";
	import { shell } from "../../lib/shell/shell.svelte";
	import type { WindowOf } from "../../lib/shell/types";
	import Button from "../../lib/ui/Button.svelte";
	import Dialog from "../../lib/ui/Dialog.svelte";
	import EmptyState from "../../lib/ui/EmptyState.svelte";
	import Skeleton from "../../lib/ui/Skeleton.svelte";
	import { toast } from "../../lib/ui/toast.svelte";
	import AddRepoForm from "./AddRepoForm.svelte";
	import { pinFirst } from "./group";
	import RepoSection from "./RepoSection.svelte";
	import RepoSettingsDialog from "./RepoSettingsDialog.svelte";
	import { lastRepo, TasksData } from "./tasksData.svelte";

	let { win, pane }: { win: WindowOf<"tasks">; pane: PaneContext<"tasks"> } = $props();

	// svelte-ignore state_referenced_locally
	const data = new TasksData(pane);
	let adding = $state(false);
	let expanded: string | null = $state(null);
	let settingsName: string | null = $state(null);
	/** The remembered repo, pinned to the top once when the window opens; undefined until the first load. */
	let pinned: string | null | undefined = $state(undefined);

	$effect(() => data.start());

	const filtered = $derived(
		data.repos === null ? null : win.props.repo ? data.repos.filter((r) => r.name === win.props.repo) : data.repos,
	);
	const repos = $derived(filtered === null ? null : pinFirst(filtered, pinned ?? null));
	const settingsRepo = $derived(data.repos?.find((r) => r.name === settingsName) ?? null);

	// Decided once, on the first load: later polls and clicks never reorder the list.
	$effect.pre(() => {
		if (pinned !== undefined || filtered === null) return;
		const last = lastRepo.get();
		pinned = last !== null && filtered.some((r) => r.name === last) ? last : null;
		expanded = pinned ?? (filtered.length === 1 ? filtered[0]!.name : null);
	});

	function toggle(name: string) {
		expanded = expanded === name ? null : name;
		if (expanded) lastRepo.set(expanded);
	}

	function openAgent(agentId: string, cwd: string) {
		if (!shell.focusWhere((w) => w.kind === "agent" && w.props.agentId === agentId)) {
			pane.open({ kind: "agent", props: { agentId, cwd } });
		}
	}

	function added(name: string) {
		adding = false;
		expanded = name;
		lastRepo.set(name);
		toast({ message: `Added ${name}`, tone: "success" });
		void data.load();
	}

	function deleted(name: string) {
		settingsName = null;
		if (expanded === name) expanded = null;
		lastRepo.forget(name);
		data.dropRepo(name);
		void data.load();
	}
</script>

<div class="tasks">
	{#if data.repos === null && data.error}
		<EmptyState icon={Icons.Warn} title="Couldn't load tasks" text={data.error}>
			{#snippet actions()}<Button variant="primary" onclick={() => data.load()}>Retry</Button>{/snippet}
		</EmptyState>
	{:else if repos === null}
		<div class="pad">
			<Skeleton preset="lines" count={1} />
			<Skeleton preset="rows" count={4} />
		</div>
	{:else if data.repos?.length === 0}
		<EmptyState icon={Icons.Tasks} title="Add a repo to start tasks" text="ROMP clones it into a shared hub; each task gets its own worktree and agent.">
			<AddRepoForm onadded={(r) => added(r.name)} />
		</EmptyState>
	{:else}
		<div class="pad">
			<header class="head">
				<h2>Repos</h2>
				<Button size="sm" icon={Icons.Add} onclick={() => (adding = true)}>Add repo</Button>
			</header>
			{#each repos as repo (repo.name)}
				<RepoSection
					{repo}
					{data}
					expanded={expanded === repo.name}
					ontoggle={() => toggle(repo.name)}
					onsettings={() => (settingsName = repo.name)}
					onagent={openAgent}
				/>
			{/each}
		</div>
	{/if}
</div>

<Dialog bind:open={adding} title="Add repo">
	<AddRepoForm onadded={(r) => added(r.name)} oncancel={() => (adding = false)} />
</Dialog>

{#if settingsRepo}
	<RepoSettingsDialog repo={settingsRepo} {data} onclose={() => (settingsName = null)} ondeleted={deleted} />
{/if}

<style>
	.tasks {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		container-type: inline-size;
	}
	.pad {
		padding: var(--sp-3) var(--sp-4);
		max-width: var(--chat-measure);
		margin-inline: auto;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-block-end: var(--sp-2);
	}
</style>
