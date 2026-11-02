<script lang="ts">
	import type { RepoInfo, RepoSuggestion } from "@romp/protocol";
	import { api, ApiFailure, errorMessage } from "../../lib/api";
	import AsyncButton from "../../lib/ui/AsyncButton.svelte";
	import Button from "../../lib/ui/Button.svelte";
	import Chip from "../../lib/ui/Chip.svelte";
	import Popover from "../../lib/ui/Popover.svelte";
	import Spinner from "../../lib/ui/Spinner.svelte";
	import { repoSearchQuery } from "./group";

	interface Props {
		onadded: (repo: RepoInfo) => void;
		oncancel?: () => void;
	}

	let { onadded, oncancel }: Props = $props();

	const DEBOUNCE_MS = 250;
	/** Searches faster than this never flash a "Searching…" row. */
	const SLOW_MS = 400;
	const GH_UNAVAILABLE =
		"GitHub search needs the gh CLI signed in on the VM (gh auth login). You can still paste a URL.";

	const listId = $props.id();

	let url = $state("");
	let name = $state("");
	let branch = $state("");
	let error: string | null = $state(null);
	let touched = $state(false);

	let input: HTMLInputElement | null = $state(null);
	let panel: HTMLElement | null = $state(null);
	let listOpen = $state(false);
	let results = $state<RepoSuggestion[] | null>(null);
	let resultsFor = $state("");
	let searchError: string | null = $state(null);
	let slow = $state(false);
	let active = $state(-1);
	let debounce: number | undefined;
	let slowTimer: number | undefined;
	let inflight: AbortController | null = null;

	const showList = $derived(listOpen && (results !== null || searchError !== null || slow));
	const activeId = $derived(showList && results && active >= 0 && active < results.length ? `${listId}-${active}` : undefined);

	function cancelSearch() {
		clearTimeout(debounce);
		clearTimeout(slowTimer);
		inflight?.abort();
		inflight = null;
		slow = false;
	}

	function closeList() {
		listOpen = false;
		active = -1;
	}

	function oninput() {
		cancelSearch();
		const q = repoSearchQuery(url);
		if (q === null) {
			closeList();
			results = null;
			searchError = null;
			return;
		}
		debounce = window.setTimeout(() => void search(q), DEBOUNCE_MS);
	}

	async function search(q: string) {
		const ctrl = new AbortController();
		inflight = ctrl;
		listOpen = document.activeElement === input;
		slowTimer = window.setTimeout(() => (slow = true), SLOW_MS);
		try {
			const found = await api.repos.search(q, ctrl.signal);
			if (ctrl.signal.aborted) return;
			results = found;
			resultsFor = q;
			searchError = null;
			active = -1;
		} catch (err) {
			if (ctrl.signal.aborted) return;
			results = null;
			searchError = err instanceof ApiFailure && err.code === "gh_unavailable" ? GH_UNAVAILABLE : errorMessage(err);
		} finally {
			if (inflight === ctrl) {
				inflight = null;
				clearTimeout(slowTimer);
				slow = false;
			}
		}
	}

	function pick(s: RepoSuggestion) {
		cancelSearch();
		url = s.url;
		results = null;
		searchError = null;
		closeList();
	}

	function move(step: 1 | -1) {
		if (!results || results.length === 0) return;
		if (!listOpen) {
			listOpen = true;
			return;
		}
		const n = results.length;
		active = active < 0 ? (step === 1 ? 0 : n - 1) : (active + step + n) % n;
		document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			if (!results?.length) return;
			e.preventDefault();
			move(e.key === "ArrowDown" ? 1 : -1);
		} else if (e.key === "Enter" && showList && results && active >= 0) {
			e.preventDefault();
			const s = results[active];
			if (s) pick(s);
		}
	}

	function onblur(e: FocusEvent) {
		// A press on the panel's padding or scrollbar focuses the panel; keep typing in the input.
		if (panel && e.relatedTarget instanceof Node && panel.contains(e.relatedTarget)) {
			input?.focus();
			return;
		}
		closeList();
	}

	async function add() {
		touched = true;
		if (!url.trim()) return;
		cancelSearch();
		closeList();
		error = null;
		try {
			const repo = await api.repos.add({
				url: url.trim(),
				name: name.trim() || undefined,
				branch: branch.trim() || undefined,
			});
			url = name = branch = "";
			results = null;
			touched = false;
			onadded(repo);
		} catch (err) {
			error = errorMessage(err);
		}
	}

	$effect(() => cancelSearch);

	// The gateway lists the user's GitHub repos once (a few seconds through gh) and caches them; start that as
	// soon as the form opens so the first typed query answers from the cache. Errors surface on a real search.
	$effect(() => {
		api.repos.search("").catch(() => {});
	});
</script>

<form class="add" onsubmit={(e) => e.preventDefault()}>
	<label>
		Repository URL
		<input
			bind:this={input}
			bind:value={url}
			required
			role="combobox"
			aria-autocomplete="list"
			aria-expanded={showList}
			aria-controls={showList ? listId : undefined}
			aria-activedescendant={activeId}
			aria-invalid={touched && !url.trim()}
			placeholder="Search your GitHub repos or paste a URL"
			autocapitalize="off"
			autocomplete="off"
			spellcheck="false"
			{oninput}
			{onkeydown}
			{onblur}
			onfocus={() => {
				if (results !== null || searchError !== null) listOpen = true;
			}}
		/>
	</label>
	<div class="pair">
		<label>
			Name <span class="subtle">(optional)</span>
			<input bind:value={name} autocapitalize="off" autocomplete="off" spellcheck="false" />
		</label>
		<label>
			Branch <span class="subtle">(optional)</span>
			<input bind:value={branch} placeholder="main" autocapitalize="off" autocomplete="off" spellcheck="false" />
		</label>
	</div>
	{#if error}<p class="field-error">{error}</p>{/if}
	<div class="actions">
		{#if oncancel}<Button onclick={oncancel}>Cancel</Button>{/if}
		<AsyncButton variant="primary" action={add} pendingLabel="Cloning…">Add repo</AsyncButton>
	</div>
</form>

<Popover anchor={input} open={showList} matchWidth bind:panel ondismiss={closeList}>
	{#if slow && !results}
		<p class="state meta" role="status"><Spinner size="sm" /> Searching…</p>
	{:else if searchError}
		<p class="state meta" role="alert">{searchError}</p>
	{:else if results && results.length === 0}
		<p class="state meta" role="status">No repos match “{resultsFor}”</p>
	{/if}
	{#if results && results.length > 0 && !searchError}
		<ul id={listId} role="listbox" aria-label="GitHub repos" onpointerdown={(e) => e.preventDefault()}>
			{#each results as s, i (s.fullName)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<li
					id="{listId}-{i}"
					role="option"
					aria-selected={i === active}
					class:active={i === active}
					onpointermove={() => (active = i)}
					onclick={() => pick(s)}
				>
					<span class="line">
						<span class="full truncate">{s.fullName}</span>
						{#if s.private}<Chip>Private</Chip>{/if}
					</span>
					{#if s.description}<span class="meta truncate">{s.description}</span>{/if}
				</li>
			{/each}
		</ul>
	{/if}
</Popover>

<style>
	.add {
		display: grid;
		gap: var(--sp-3);
		width: 100%;
		text-align: start;
	}
	.pair {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
		gap: var(--sp-3);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
	}
	.state {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: var(--sp-2);
	}
	ul {
		padding: 0;
	}
	li {
		display: grid;
		gap: var(--sp-1);
		min-width: 0;
		padding: var(--sp-2);
		border-radius: var(--radius-md);
		list-style: none;
		cursor: pointer;
		&.active {
			background: var(--surface-3);
		}
	}
	.line {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-width: 0;
	}
	.full {
		font-weight: 500;
	}
</style>
