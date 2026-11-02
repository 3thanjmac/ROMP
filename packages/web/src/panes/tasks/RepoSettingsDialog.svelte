<script lang="ts">
	import { MAX_ENV_BYTES, type RepoInfo } from "@romp/protocol";
	import { api, errorMessage } from "../../lib/api";
	import { Icons } from "../../lib/icons";
	import AsyncButton from "../../lib/ui/AsyncButton.svelte";
	import Button from "../../lib/ui/Button.svelte";
	import Dialog from "../../lib/ui/Dialog.svelte";
	import { toast } from "../../lib/ui/toast.svelte";
	import { remoteLabel } from "./group";
	import type { TasksData } from "./tasksData.svelte";

	interface Props {
		repo: RepoInfo;
		data: TasksData;
		/** The dialog closed (Back, Cancel, Escape, Save). */
		onclose: () => void;
		/** The repo was deleted on the server. */
		ondeleted: (name: string) => void;
	}

	let { repo, data, onclose, ondeleted }: Props = $props();

	const id = $props.id();
	const ENV_LIMIT = `${MAX_ENV_BYTES / 1024} KB`;

	let open = $state(true);

	// svelte-ignore state_referenced_locally
	let branch = $state(repo.branch);
	let branches: string[] | null = $state(null);
	let branchesError: string | null = $state(null);

	let envFile = $state<File | null>(null);
	let removeEnv = $state(false);
	let envError: string | null = $state(null);
	let fileInput: HTMLInputElement;

	let saveError: string | null = $state(null);

	let confirmOpen = $state(false);
	let confirmName = $state("");
	let deleteError: string | null = $state(null);

	const branchChanged = $derived(branch !== repo.branch);
	const changed = $derived(branchChanged || envFile !== null || removeEnv);
	const options = $derived.by(() => {
		const list = branches ?? [];
		return list.includes(repo.branch) ? list : [repo.branch, ...list];
	});
	const envStatus = $derived(
		envFile
			? `${envFile.name} will be uploaded when you save`
			: removeEnv
				? ".env will be removed when you save"
				: repo.env
					? ".env uploaded"
					: "No .env uploaded",
	);

	async function loadBranches(signal?: AbortSignal) {
		branchesError = null;
		branches = null;
		try {
			branches = (await api.repos.branches(repo.name, signal)).branches;
		} catch (err) {
			if (signal?.aborted) return;
			branchesError = errorMessage(err);
		}
	}

	$effect(() => {
		const ctrl = new AbortController();
		void loadBranches(ctrl.signal);
		return () => ctrl.abort();
	});

	function pickEnv() {
		const file = fileInput.files?.[0];
		fileInput.value = "";
		if (!file) return;
		if (file.size > MAX_ENV_BYTES) {
			envError = `${file.name} is ${Math.ceil(file.size / 1024)} KB; a .env can be at most ${ENV_LIMIT}.`;
			return;
		}
		envError = null;
		envFile = file;
		removeEnv = false;
	}

	function undoEnv() {
		envFile = null;
		removeEnv = false;
		envError = null;
	}

	async function save() {
		saveError = null;
		let step = "switch the integration branch";
		try {
			if (branchChanged) data.replaceRepo(await api.repos.settings(repo.name, { branch }));
			if (envFile) {
				step = "upload the .env";
				data.replaceRepo(await api.repos.setEnv(repo.name, envFile));
				envFile = null;
			} else if (removeEnv) {
				step = "remove the .env";
				data.replaceRepo(await api.repos.clearEnv(repo.name));
				removeEnv = false;
			}
		} catch (err) {
			saveError = `Couldn't ${step}: ${errorMessage(err)}`;
			void data.load();
			return;
		}
		toast({ message: `Saved settings for ${repo.name}`, tone: "success" });
		open = false;
	}

	function askDelete() {
		confirmName = "";
		deleteError = null;
		confirmOpen = true;
	}

	async function remove() {
		deleteError = null;
		const name = repo.name;
		try {
			await api.repos.remove(name);
		} catch (err) {
			deleteError = errorMessage(err);
			return;
		}
		confirmOpen = false;
		open = false;
		toast({ message: `Deleted ${name}` });
		ondeleted(name);
	}
</script>

<Dialog bind:open label="Settings for {repo.name}" {onclose}>
	<header class="top">
		<Button variant="ghost" size="sm" icon={Icons.Back} onclick={() => (open = false)}>Back</Button>
		<h2 class="truncate">{repo.name}</h2>
	</header>

	<section>
		<h3 id="{id}-branch">Integration branch</h3>
		{#if branches === null && !branchesError}
			<select aria-labelledby="{id}-branch" disabled>
				<option>Loading branches…</option>
			</select>
		{:else}
			<select aria-labelledby="{id}-branch" bind:value={branch} disabled={branchesError !== null}>
				{#each options as b (b)}<option value={b}>{b}</option>{/each}
			</select>
		{/if}
		{#if branchesError}
			<div class="inline-error">
				<p class="field-error">Couldn't load branches: {branchesError}</p>
				<Button size="sm" variant="ghost" icon={Icons.Reload} onclick={() => loadBranches()}>Retry</Button>
			</div>
		{:else}
			<p class="meta">Tasks branch from it, and Ship lands back into it.</p>
		{/if}
	</section>

	<section>
		<h3>Environment</h3>
		<p class="status" role="status">{envStatus}</p>
		<div class="buttons">
			<input bind:this={fileInput} type="file" class="sr-only" tabindex="-1" aria-hidden="true" onchange={pickEnv} />
			<Button size="sm" icon={Icons.Upload} onclick={() => fileInput.click()}>Upload .env</Button>
			{#if envFile || removeEnv}
				<Button size="sm" variant="ghost" icon={Icons.Undo} onclick={undoEnv}>Undo</Button>
			{:else if repo.env}
				<Button size="sm" variant="ghost" icon={Icons.Trash} onclick={() => (removeEnv = true)}>Remove .env</Button>
			{/if}
		</div>
		{#if envError}<p class="field-error">{envError}</p>{/if}
		<p class="meta">New tasks get a copy as .env in their worktree; it is never committed. Up to {ENV_LIMIT}.</p>
	</section>

	<section class="danger">
		<h3>Danger zone</h3>
		<div class="buttons">
			<Button size="sm" variant="danger" icon={Icons.Trash} onclick={askDelete}>Delete repository</Button>
		</div>
	</section>

	{#if saveError}<p class="field-error">{saveError}</p>{/if}

	{#snippet footer()}
		<Button onclick={() => (open = false)}>Cancel</Button>
		<AsyncButton
			variant="primary"
			action={save}
			pendingLabel="Saving…"
			disabledReason={changed ? null : "Nothing to save yet"}
		>
			Save
		</AsyncButton>
	{/snippet}
</Dialog>

<Dialog bind:open={confirmOpen} title="Delete {repo.name}?">
	<p class="muted">
		Permanently deletes the hub repo plus all your tasks and worktrees for it, including unshipped commits.
		{#if repo.remote}
			The repo at <span class="mono">{remoteLabel(repo.remote)}</span> is not touched.
		{:else}
			It has no remote, so nothing else keeps a copy of its history.
		{/if}
	</p>
	<label>
		<span>Type <span class="mono">{repo.name}</span> to confirm</span>
		<input bind:value={confirmName} autocapitalize="off" autocomplete="off" spellcheck="false" />
	</label>
	{#if deleteError}<p class="field-error">{deleteError}</p>{/if}
	{#snippet footer()}
		<Button onclick={() => (confirmOpen = false)}>Cancel</Button>
		<AsyncButton
			variant="danger"
			action={remove}
			pendingLabel="Deleting…"
			disabledReason={confirmName.trim() === repo.name ? null : `Type ${repo.name} to confirm`}
		>
			Delete repository
		</AsyncButton>
	{/snippet}
</Dialog>

<style>
	.top {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-width: 0;
	}
	section {
		display: grid;
		gap: var(--sp-2);
	}
	.danger {
		padding-block-start: var(--sp-3);
		border-block-start: var(--border);
	}
	.inline-error,
	.buttons {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--sp-2);
	}
	.inline-error .field-error {
		margin: 0;
	}
	.status {
		font-size: var(--text-sm);
	}
</style>
