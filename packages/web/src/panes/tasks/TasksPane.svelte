<script lang="ts">
	import { untrack } from "svelte";
	import { Icons } from "../../lib/icons";
	import type { PaneContext } from "../../lib/shell/pane.svelte";
	import { shell } from "../../lib/shell/shell.svelte";
	import type { WindowOf } from "../../lib/shell/types";
	import Button from "../../lib/ui/Button.svelte";
	import Dialog from "../../lib/ui/Dialog.svelte";
	import EmptyState from "../../lib/ui/EmptyState.svelte";
	import Skeleton from "../../lib/ui/Skeleton.svelte";
	import { repoColorVar } from "../../lib/repoColors.svelte";
	import { toast } from "../../lib/ui/toast.svelte";
	import AddRepoForm from "./AddRepoForm.svelte";
	import { pinFirst } from "./group";
	import RepoPage from "./RepoPage.svelte";
	import RepoRow from "./RepoRow.svelte";
	import RepoSettingsDialog from "./RepoSettingsDialog.svelte";
	import type { RepoInfo } from "@romp/protocol";
	import { lastRepo, TasksData } from "./tasksData.svelte";

	let { win, pane }: { win: WindowOf<"tasks">; pane: PaneContext<"tasks"> } = $props();

	// svelte-ignore state_referenced_locally
	const data = new TasksData(pane);
	let adding = $state(false);
	let settingsName: string | null = $state(null);
	/** Set when another window asked for the settings at the Dev command. */
	let settingsFocus: "dev" | undefined = $state(undefined);
	/** The remembered repo, pinned to the top once when the window opens; undefined until the first load. */
	let pinned: string | null | undefined = $state(undefined);
	let scroller: HTMLDivElement | undefined = $state();
	/** The list's scroll position when a repo page opened, restored by Back. */
	let listScroll = 0;

	$effect(() => data.start());

	// A Browser window's "Set dev command" asks, through this window's props, for a repo's settings at Dev.
	$effect(() => {
		const name = win.props.settings;
		if (!name || data.repos === null) return;
		settingsName = name;
		settingsFocus = "dev";
		pane.setProps({ settings: undefined });
	});

	/** The repo whose page is open (`win.props.repo`), like a folder in the Files window. */
	const current = $derived(
		win.props.repo && data.repos ? (data.repos.find((r) => r.name === win.props.repo) ?? null) : null,
	);
	const repos = $derived(data.repos === null ? null : pinFirst(data.repos, pinned ?? null));
	const settingsRepo = $derived(data.repos?.find((r) => r.name === settingsName) ?? null);

	// Decided once, on the first load: later polls and clicks never reorder the list.
	$effect.pre(() => {
		if (pinned !== undefined || data.repos === null) return;
		const last = lastRepo.get();
		pinned = last !== null && data.repos.some((r) => r.name === last) ? last : null;
	});

	// A page for a repo that is gone (deleted here or elsewhere) falls back to the list.
	$effect(() => {
		if (win.props.repo && data.repos !== null && current === null) pane.setProps({ repo: undefined });
	});

	$effect(() => {
		pane.status.tint = current ? repoColorVar(current.color) : null;
	});

	// A page opens at its top; Back returns to where the list was.
	const onPage = $derived(current !== null);
	$effect(() => {
		const page = onPage;
		untrack(() => {
			if (scroller) scroller.scrollTop = page ? 0 : listScroll;
		});
	});

	function openRepo(name: string) {
		listScroll = scroller?.scrollTop ?? 0;
		pane.setProps({ repo: name });
		lastRepo.set(name);
	}

	function openAgent(agentId: string, cwd: string) {
		if (!shell.focusWhere((w) => w.kind === "agent" && w.props.agentId === agentId)) {
			pane.open({ kind: "agent", props: { agentId, cwd } });
		}
	}

	function added(repo: RepoInfo) {
		adding = false;
		data.addRepo(repo);
		openRepo(repo.name);
		toast({ message: `Added ${repo.name}`, tone: "success" });
		void data.load();
	}

	function deleted(name: string) {
		settingsName = null;
		if (win.props.repo === name) pane.setProps({ repo: undefined });
		lastRepo.forget(name);
		data.dropRepo(name);
		void data.load();
	}
</script>

<div class="tasks" bind:this={scroller}>
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
			<AddRepoForm onadded={added} />
		</EmptyState>
	{:else}
		<div class="pad">
			{#if current}
				<RepoPage
					repo={current}
					{data}
					onback={() => pane.setProps({ repo: undefined })}
					onsettings={() => ((settingsName = current.name), (settingsFocus = undefined))}
					onagent={openAgent}
				/>
			{:else}
				<header class="head">
					<h2>Repos</h2>
					<Button size="sm" icon={Icons.Add} onclick={() => (adding = true)}>Add repo</Button>
				</header>
				<ul class="list">
					{#each repos as repo (repo.name)}
						<RepoRow
							{repo}
							{data}
							onopen={() => openRepo(repo.name)}
							onsettings={() => ((settingsName = repo.name), (settingsFocus = undefined))}
						/>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

<Dialog bind:open={adding} title="Add repo">
	<AddRepoForm onadded={added} oncancel={() => (adding = false)} />
</Dialog>

{#if settingsRepo}
	<RepoSettingsDialog
		repo={settingsRepo}
		{data}
		focus={settingsFocus}
		onclose={() => (settingsName = null)}
		ondeleted={deleted}
	/>
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
	.list {
		padding: 0;
	}
</style>
