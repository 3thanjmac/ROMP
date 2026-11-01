<script lang="ts">
	import type { GitIdentity } from "@romp/protocol";
	import { onMount } from "svelte";
	import { api, errorMessage } from "../api";
	import { Icons } from "../icons";
	import { disablePush, enablePush, push, testPush } from "../push.svelte";
	import AsyncButton from "../ui/AsyncButton.svelte";
	import Button from "../ui/Button.svelte";
	import IconButton from "../ui/IconButton.svelte";
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
	let page: HTMLElement;
	let heading: HTMLHeadingElement;

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

	onMount(() => {
		void load();
		const opener = document.activeElement;
		heading.focus();
		return () => {
			// Hand focus back to whatever opened the page, unless closing it already moved focus (a setup terminal).
			requestAnimationFrame(() => {
				if (opener instanceof HTMLElement && opener.isConnected && document.activeElement === document.body) opener.focus();
			});
		};
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

	type PushAction = "enable" | "test" | "disable";
	const PUSH_RUN: Record<PushAction, () => Promise<void>> = { enable: enablePush, test: testPush, disable: disablePush };
	const PUSH_FAILURE: Record<PushAction, string> = {
		enable: "Couldn't turn on notifications.",
		test: "Couldn't send the test notification.",
		disable: "Couldn't turn off notifications.",
	};
	let pushBusy: PushAction | null = $state(null);
	let pushFailed: PushAction | null = $state(null);
	let pushError: string | null = $state(null);
	let pushSent = $state(false);

	/** Errors stay on the page with a Retry instead of propagating out of AsyncButton. */
	async function runPush(action: PushAction) {
		if (pushBusy) return;
		pushBusy = action;
		pushFailed = pushError = null;
		pushSent = false;
		try {
			await PUSH_RUN[action]();
			pushSent = action === "test";
		} catch (err) {
			pushFailed = action;
			pushError = errorMessage(err);
		} finally {
			pushBusy = null;
		}
	}

	/** Opens a terminal running `command`, or focuses the window that already runs it. */
	function run(title: string, command: string[]) {
		frameUi.closeSettings();
		const line = command.join(" ");
		if (shell.focusWhere((w) => w.kind === "terminal" && w.props.command?.join(" ") === line, { keyboard: true })) return;
		shell.open({ kind: "terminal", title, props: { command } }, { keyboard: true });
	}

	function keydown(e: KeyboardEvent) {
		// Only keys pressed on the page itself; Escape inside a dialog opened on top belongs to that dialog.
		if (e.key !== "Escape" || e.defaultPrevented || !page.contains(e.target as Node)) return;
		e.preventDefault();
		frameUi.closeSettings();
	}
</script>

<svelte:window onkeydown={keydown} />

<section class="page" bind:this={page} aria-labelledby="settings-title">
	<header>
		<IconButton label="Back" icon={Icons.Back} size="bar" onclick={() => frameUi.closeSettings()} />
		<h1 id="settings-title" tabindex="-1" bind:this={heading}>Settings</h1>
	</header>
	<div class="content">
		<p class="note">These apply to your account only; other people on this server set up their own.</p>
		<section aria-labelledby="settings-git-identity">
			<h2 id="settings-git-identity">Git identity</h2>
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
		<section aria-labelledby="settings-notifications">
			<h2 id="settings-notifications">Notifications</h2>
			<p class="note">
				Get a banner when an agent asks a question, needs approval, finishes, or stops unexpectedly. ROMP stays quiet
				while it is open and focused on this device.
			</p>
			{#if push.support === "unsupported"}
				<p>This browser or connection can't use push notifications. Open ROMP over HTTPS in a supported browser.</p>
			{:else if push.support === "install"}
				<p>
					On iPhone or iPad, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>. Open ROMP from the
					Home Screen and come back here to turn on notifications.
				</p>
			{:else if push.ready && push.permission === "denied"}
				<p>Notifications are blocked for ROMP. Allow them in your browser or device settings, then reload ROMP.</p>
			{:else if push.ready && push.subscribed}
				<div class="actions">
					<AsyncButton
						size="sm"
						variant="secondary"
						icon={Icons.Send}
						action={() => runPush("test")}
						pendingLabel="Sending…"
						disabled={pushBusy !== null}
					>
						Send test notification
					</AsyncButton>
					<AsyncButton
						size="sm"
						variant="ghost"
						action={() => runPush("disable")}
						pendingLabel="Turning off…"
						disabled={pushBusy !== null}
					>
						Turn off notifications
					</AsyncButton>
				</div>
			{:else if push.ready}
				<div class="actions">
					<AsyncButton
						size="sm"
						action={() => runPush("enable")}
						pendingLabel="Turning on…"
						disabled={pushBusy !== null}
					>
						Turn on notifications
					</AsyncButton>
				</div>
			{/if}
			{#if pushError && pushFailed}
				{@const failed = pushFailed}
				<div class="error-row">
					<p class="field-error" role="alert">{PUSH_FAILURE[failed]} {pushError}</p>
					<AsyncButton
						size="sm"
						variant="secondary"
						action={() => runPush(failed)}
						pendingLabel="Retrying…"
						disabled={pushBusy !== null}
					>
						Retry
					</AsyncButton>
				</div>
			{:else if push.support === "ok"}
				<p class="meta" role="status" aria-live="polite">
					{#if !push.ready}
						Checking notification settings…
					{:else if pushSent}
						Test notification sent.
					{:else if push.permission !== "denied" && !pushBusy}
						{push.subscribed ? "Notifications are on for this device." : "Notifications are off for this device."}
					{/if}
				</p>
			{/if}
		</section>
		<section aria-labelledby="settings-account-setup">
			<h2 id="settings-account-setup">Account setup</h2>
			<p class="note">Each opens a terminal that runs as your own Linux account.</p>
			<div class="rows">
				{#each SETUP as s (s.title)}
					<div class="row">
						<div class="head">
							<h3>{s.name}</h3>
							<Button size="sm" icon={Icons.Terminal} onclick={() => run(s.title, s.command)}>{s.action}</Button>
						</div>
						<p>{s.text}</p>
						<code>{s.command.join(" ")}</code>
					</div>
				{/each}
			</div>
		</section>
	</div>
</section>

<style>
	.page {
		position: fixed;
		inset-inline: 0;
		top: var(--vv-top);
		height: var(--vvh);
		z-index: var(--z-page);
		overflow-y: auto;
		overscroll-behavior: contain;
		color: var(--fg);
		background: var(--bg);
	}
	header {
		position: sticky;
		top: 0;
		z-index: var(--z-bar);
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		height: calc(var(--topbar-h) + var(--safe-top));
		padding: var(--safe-top) calc(var(--sp-2) + var(--safe-right)) 0 calc(var(--sp-2) + var(--safe-left));
		background: var(--surface-2);
		border-block-end: var(--border);
	}
	h1:focus {
		outline: none;
	}
	.content {
		display: grid;
		gap: var(--sp-6);
		max-width: var(--settings-w);
		margin-inline: auto;
		padding: var(--sp-6) calc(var(--sp-6) + var(--safe-right)) calc(var(--sp-6) + var(--safe-bottom))
			calc(var(--sp-6) + var(--safe-left));
	}
	section:not(.page),
	.rows {
		display: grid;
		gap: var(--sp-3);
	}
	section:not(.page, :last-of-type) {
		border-bottom: var(--border);
		padding-bottom: var(--sp-6);
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
		.content {
			padding: var(--sp-4) calc(var(--sp-4) + var(--safe-right)) calc(var(--sp-4) + var(--safe-bottom))
				calc(var(--sp-4) + var(--safe-left));
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
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
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
