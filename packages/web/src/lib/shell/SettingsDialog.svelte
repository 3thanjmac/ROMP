<script lang="ts">
	import type { GitIdentity } from "@romp/protocol";
	import { untrack } from "svelte";
	import { api, errorMessage } from "../api";
	import { Icons } from "../icons";
	import AsyncButton from "../ui/AsyncButton.svelte";
	import Button from "../ui/Button.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import { shell } from "./shell.svelte";
	import { frameUi } from "./ui.svelte";

	type Field = keyof GitIdentity;

	/** Sign-ins for the user's own Linux account; each runs in a terminal because it is interactive. */
	const SETUP = [
		{
			name: "GitHub",
			action: "Set up GitHub",
			title: "GitHub setup",
			text: "Sign in so you can clone private repos when adding them. Choose HTTPS, then let gh authenticate Git.",
			command: ["gh", "auth", "login"],
		},
		{
			name: "AI providers",
			action: "Set up OMP",
			title: "OMP setup",
			text: "Sign in to AI providers and pick the models your agents use.",
			command: ["omp", "setup"],
		},
	];

	/** Identity as the gateway last reported it; null while loading or after a failed load. */
	let saved: GitIdentity | null = $state(null);
	let draft: GitIdentity = $state({ name: "", email: "" });
	let errors: Record<Field, string | null> = $state({ name: null, email: null });
	let loadError: string | null = $state(null);
	let status: "idle" | "saving" | "saved" = $state("idle");
	let saveError: string | null = $state(null);
	let failed: Partial<GitIdentity> = {};
	/** Bumped per request so a late response never overwrites a newer one. */
	let seq = 0;

	async function load() {
		const mine = ++seq;
		saved = loadError = saveError = null;
		errors = { name: null, email: null };
		status = "idle";
		try {
			const identity = await api.gitIdentity.get();
			if (mine !== seq) return;
			saved = identity;
			draft = { ...identity };
		} catch (err) {
			if (mine === seq) loadError = errorMessage(err);
		}
	}

	$effect(() => {
		if (frameUi.settings) untrack(load);
	});

	function check(field: Field, el: HTMLInputElement) {
		if (!el.value.trim()) errors[field] = field === "name" ? "Name is required." : "Email is required.";
		else errors[field] = el.validity.valid ? null : "Enter a valid email address.";
	}

	function edited(field: Field, el: HTMLInputElement) {
		if (status === "saved") status = "idle";
		if (errors[field]) check(field, el);
	}

	/** Autosave: runs on `change`, so once per edit when the field loses focus or Enter is pressed. */
	async function commit(field: Field, el: HTMLInputElement) {
		check(field, el);
		const value = el.value.trim();
		if (errors[field] || !saved || value === saved[field]) return;
		await save({ [field]: value });
	}

	async function save(update: Partial<GitIdentity>) {
		const mine = ++seq;
		status = "saving";
		saveError = null;
		try {
			const identity = await api.gitIdentity.set(update);
			if (mine !== seq) return;
			saved = identity;
			status = "saved";
		} catch (err) {
			if (mine !== seq) return;
			status = "idle";
			failed = update;
			saveError = errorMessage(err);
		}
	}

	/** Opens a terminal running `command`, or focuses the window that already runs it. */
	function run(title: string, command: string[]) {
		frameUi.settings = false;
		const line = command.join(" ");
		if (shell.focusWhere((w) => w.kind === "terminal" && w.props.command?.join(" ") === line, { keyboard: true })) return;
		shell.open({ kind: "terminal", title, props: { command } }, { keyboard: true });
	}
</script>

<Dialog bind:open={frameUi.settings} title="Settings">
	<p class="note">These apply to your account only; other people on this server set up their own.</p>
	<section aria-labelledby="settings-git-identity">
		<h3 id="settings-git-identity">Git identity</h3>
		<p class="note">Used as the author on your commits.</p>
		<div class="pair">
			<label>
				Name
				{#if saved || loadError}
					<input
						bind:value={draft.name}
						required
						disabled={!saved}
						autocomplete="name"
						aria-invalid={!!errors.name}
						oninput={(e) => edited("name", e.currentTarget)}
						onblur={(e) => check("name", e.currentTarget)}
						onchange={(e) => commit("name", e.currentTarget)}
					/>
				{:else}
					<div class="skeleton input-skeleton" aria-hidden="true"></div>
				{/if}
				{#if errors.name}<span class="field-error">{errors.name}</span>{/if}
			</label>
			<label>
				Email
				{#if saved || loadError}
					<input
						bind:value={draft.email}
						type="email"
						required
						disabled={!saved}
						autocomplete="email"
						autocapitalize="off"
						spellcheck="false"
						aria-invalid={!!errors.email}
						oninput={(e) => edited("email", e.currentTarget)}
						onblur={(e) => check("email", e.currentTarget)}
						onchange={(e) => commit("email", e.currentTarget)}
					/>
				{:else}
					<div class="skeleton input-skeleton" aria-hidden="true"></div>
				{/if}
				{#if errors.email}<span class="field-error">{errors.email}</span>{/if}
			</label>
		</div>
		{#if loadError}
			<div class="error-row">
				<p class="field-error" role="alert">Couldn't load your Git identity. {loadError}</p>
				<AsyncButton size="sm" variant="secondary" action={load} pendingLabel="Loading…">Retry</AsyncButton>
			</div>
		{:else if saveError}
			<div class="error-row">
				<p class="field-error" role="alert">Couldn't save your Git identity. {saveError} Your edits are still here.</p>
				<AsyncButton size="sm" variant="secondary" action={() => save(failed)} pendingLabel="Saving…">Retry</AsyncButton>
			</div>
		{:else}
			<p class="meta" role="status" aria-live="polite">
				{#if !saved}Loading Git identity…{:else if status === "saving"}Saving…{:else if status === "saved"}Saved{/if}
			</p>
		{/if}
	</section>
	<section aria-labelledby="settings-account-setup">
		<h3 id="settings-account-setup">Account setup</h3>
		<p class="note">Each opens a terminal that runs as your own Linux account.</p>
		<div class="rows">
			{#each SETUP as s (s.title)}
				<div class="row">
					<div class="head">
						<h4>{s.name}</h4>
						<Button size="sm" icon={Icons.Terminal} onclick={() => run(s.title, s.command)}>{s.action}</Button>
					</div>
					<p>{s.text}</p>
					<code>{s.command.join(" ")}</code>
				</div>
			{/each}
		</div>
	</section>
	{#snippet footer()}
		<Button onclick={() => (frameUi.settings = false)}>Close</Button>
	{/snippet}
</Dialog>

<style>
	section,
	.rows {
		display: grid;
		gap: var(--sp-3);
	}
	section:not(:last-of-type) {
		border-bottom: var(--border);
		padding-bottom: var(--sp-4);
	}
	.note,
	code {
		color: var(--fg-muted);
	}
	.pair {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
		gap: var(--sp-3);
	}
	@media (pointer: coarse) {
		.pair {
			grid-template-columns: 1fr;
		}
	}
	.input-skeleton {
		min-height: calc(1lh + var(--sp-2) * 2 + 2px);
	}
	.error-row,
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--sp-2) var(--sp-3);
	}
	.error-row .field-error {
		margin-top: 0;
	}
	.row {
		display: grid;
		gap: var(--sp-2);
		&:not(:last-child) {
			border-bottom: var(--border);
			padding-bottom: var(--sp-3);
		}
	}
	code {
		display: block;
		overflow-wrap: anywhere;
	}
</style>
