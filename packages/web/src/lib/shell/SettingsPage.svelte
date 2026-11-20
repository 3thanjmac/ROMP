<script lang="ts" module>
	/**
	 * The installed commit the first update status reported while this page's JavaScript was running: the closest the
	 * page gets to knowing which build it is. A different installed commit later means it is stale.
	 */
	let loadedSha: string | null | undefined;
</script>

<script lang="ts">
	import type { CloudflareStatus, CloudflareWorker, GitIdentity, UpdateStatus } from "@romp/protocol";
	import { onMount } from "svelte";
	import { api, errorMessage } from "../api";
	import { relativeTime } from "../format";
	import { Icons } from "../icons";
	import { disablePush, enablePush, push, testPush } from "../push.svelte";
	import AsyncButton from "../ui/AsyncButton.svelte";
	import Banner from "../ui/Banner.svelte";
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
		void loadCloudflare();
		void loadUpdate();
		const opener = document.activeElement;
		heading.focus();
		return () => {
			updateSeq++;
			clearTimeout(updateTimer);
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

	const UPDATE_POLL_MS = 2_000;
	const UPDATE_TONE = { current: "neutral", updated: "info", waiting: "warning", paused: "warning", failed: "danger" } as const;
	/** romp-update as the gateway reports it; null while loading or after a failed load. */
	let update: UpdateStatus | null = $state(null);
	let updateLoadError: string | null = $state(null);
	let updateRunError: string | null = $state(null);
	/** A status poll failed mid-update: the gateways are restarting. */
	let updateReconnecting = $state(false);
	let updateSeq = 0;
	let updateTimer: ReturnType<typeof setTimeout> | undefined;
	const reloadNeeded = $derived.by(
		() => !!update?.installed && !update.running && loadedSha !== undefined && update.installed.sha !== loadedSha,
	);

	const age = (ms: number) => (relativeTime(ms) === "now" ? "just now" : `${relativeTime(ms)} ago`);

	function showUpdate(next: UpdateStatus) {
		if (loadedSha === undefined) loadedSha = next.installed?.sha ?? null;
		update = next;
		updateReconnecting = false;
		clearTimeout(updateTimer);
		if (next.available && next.running) updateTimer = setTimeout(pollUpdate, UPDATE_POLL_MS);
	}

	async function loadUpdate() {
		const mine = ++updateSeq;
		clearTimeout(updateTimer);
		updateLoadError = null;
		try {
			const next = await api.update.status();
			if (mine === updateSeq) showUpdate(next);
		} catch (err) {
			if (mine === updateSeq) updateLoadError = errorMessage(err);
		}
	}

	async function pollUpdate() {
		const mine = ++updateSeq;
		try {
			const next = await api.update.status();
			if (mine === updateSeq) showUpdate(next);
		} catch {
			// Installing restarts every gateway, this one included; keep asking until it answers again.
			if (mine !== updateSeq) return;
			updateReconnecting = true;
			updateTimer = setTimeout(pollUpdate, UPDATE_POLL_MS);
		}
	}

	async function runUpdate() {
		const mine = ++updateSeq;
		clearTimeout(updateTimer);
		updateRunError = null;
		try {
			const next = await api.update.run();
			if (mine === updateSeq) showUpdate(next);
		} catch (err) {
			if (mine === updateSeq) updateRunError = errorMessage(err);
		}
	}

	/**
	 * Prefills a user token with Queues Edit and Workers Scripts Read. Workers CI (Builds Configuration) Read has no
	 * short key a user-token link accepts, so the copy asks for it.
	 */
	const TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(
		JSON.stringify([
			{ key: "queues", type: "edit" },
			{ key: "workers_scripts", type: "read" },
		]),
	)}&accountId=*&zoneId=all&name=${encodeURIComponent("ROMP builds")}`;

	/** null while loading or after a failed load. */
	let cf: CloudflareStatus | null = $state(null);
	let cfLoadError: string | null = $state(null);
	let token = $state("");
	let connectError: string | null = $state(null);
	let disconnectError: string | null = $state(null);
	let cfBusy: "connect" | "disconnect" | null = $state(null);
	let cfMessage: string | null = $state(null);
	/** null while loading or after a failed load. */
	let workers: CloudflareWorker[] | null = $state(null);
	let workersError: string | null = $state(null);
	let workerPending: Record<string, boolean> = $state({});
	let workerErrors: Record<string, string> = $state({});
	/** Bumped per status or Workers load so a late response never overwrites a newer one. */
	let cfSeq = 0;

	async function loadCloudflare() {
		const mine = ++cfSeq;
		cf = cfLoadError = null;
		try {
			const status = await api.cloudflare.status();
			if (mine !== cfSeq) return;
			cf = status;
			if (status.connected) await loadWorkers();
		} catch (err) {
			if (mine === cfSeq) cfLoadError = errorMessage(err);
		}
	}

	async function loadWorkers() {
		const mine = ++cfSeq;
		workers = workersError = null;
		try {
			const list = await api.cloudflare.workers();
			if (mine === cfSeq) workers = list;
		} catch (err) {
			if (mine === cfSeq) workersError = errorMessage(err);
		}
	}

	async function connect(e: SubmitEvent) {
		e.preventDefault();
		if (cfBusy) return;
		cfBusy = "connect";
		connectError = cfMessage = null;
		try {
			cf = await api.cloudflare.connect(token);
			token = "";
			cfMessage = "Connected. Choose which Workers send build notifications.";
			void loadWorkers();
		} catch (err) {
			connectError = errorMessage(err);
		} finally {
			cfBusy = null;
		}
	}

	async function disconnect() {
		if (cfBusy) return;
		cfBusy = "disconnect";
		disconnectError = cfMessage = null;
		try {
			const { leftover } = await api.cloudflare.disconnect();
			cfSeq++;
			cf = { connected: false };
			workers = null;
			workerErrors = {};
			cfMessage = leftover ?? "Disconnected. ROMP removed its queue and subscriptions from Cloudflare.";
		} catch (err) {
			disconnectError = errorMessage(err);
		} finally {
			cfBusy = null;
		}
	}

	/** Optimistic: the box changes at once and flips back with the reason if Cloudflare refuses. */
	async function toggleWorker(worker: CloudflareWorker, subscribed: boolean) {
		const { name } = worker;
		worker.subscribed = subscribed;
		workerPending[name] = true;
		delete workerErrors[name];
		try {
			await api.cloudflare.setWorker(name, subscribed);
		} catch (err) {
			worker.subscribed = !subscribed;
			workerErrors[name] = errorMessage(err);
		} finally {
			delete workerPending[name];
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
				Get a banner when an agent asks a question, needs approval, finishes, or stops unexpectedly. Agent notices stay
				quiet while ROMP is open and focused on this device.
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
		<section aria-labelledby="settings-cloudflare-builds">
			<h2 id="settings-cloudflare-builds">Cloudflare builds</h2>
			<p class="note">
				Get a notification when a Workers Builds build succeeds, fails, or is canceled. These arrive even while ROMP is
				open, and tapping one opens the build in Cloudflare.
			</p>
			{#if push.support !== "ok" || (push.ready && (!push.subscribed || push.permission === "denied"))}
				<p class="note">
					This device isn't getting notifications, so build results only reach your other devices. See Notifications
					above.
				</p>
			{/if}
			{#if cfLoadError}
				<div class="error-row">
					<p class="field-error" role="alert">Couldn't load Cloudflare builds. {cfLoadError}</p>
					<AsyncButton size="sm" variant="secondary" action={loadCloudflare} pendingLabel="Loading…">Retry</AsyncButton>
				</div>
			{:else if !cf}
				<div class="skeleton input-skeleton" aria-busy="true" aria-label="Loading Cloudflare builds"></div>
			{:else if !cf.connected}
				<p class="note">
					<a href={TOKEN_URL} target="_blank" rel="noopener noreferrer">Create a Cloudflare API token</a>
					under My Profile. The link fills in Queues · Edit and Workers Scripts · Read; also add Workers Builds
					Configuration · Read, and limit it to the account your Workers are in.
				</p>
				<form class="token-form" onsubmit={connect}>
					<label>
						API token
						<input
							bind:value={token}
							type="password"
							required
							autocomplete="off"
							autocapitalize="off"
							spellcheck="false"
							aria-invalid={!!connectError}
							oninput={() => (connectError = null)}
						/>
						{#if connectError}<span class="field-error" role="alert">{connectError}</span>{/if}
					</label>
					<div class="actions">
						<AsyncButton type="submit" size="sm" pending={cfBusy === "connect"} pendingLabel="Connecting…">
							Connect
						</AsyncButton>
					</div>
				</form>
				{#if cfMessage}<p class="meta" role="status" aria-live="polite">{cfMessage}</p>{/if}
			{:else}
				<div class="head">
					<h3>{cf.accountName}</h3>
					<AsyncButton
						size="sm"
						variant="ghost"
						action={disconnect}
						pending={cfBusy === "disconnect"}
						pendingLabel="Disconnecting…"
						disabled={cfBusy !== null}
					>
						Disconnect
					</AsyncButton>
				</div>
				<p class="note">
					Builds reach ROMP through the queue {cf.queueName}. Disconnecting deletes it and the subscriptions below.
				</p>
				{#if cf.pollError}
					<Banner
						tone="warning"
						icon={Icons.Warn}
						text="Couldn't read build events: {cf.pollError}. If the token was revoked or expired, disconnect and connect with a new one."
					/>
				{/if}
				{#if disconnectError}
					<div class="error-row">
						<p class="field-error" role="alert">Couldn't disconnect. {disconnectError}</p>
						<AsyncButton size="sm" variant="secondary" action={disconnect} pendingLabel="Disconnecting…">Retry</AsyncButton>
					</div>
				{:else if cfMessage}
					<p class="meta" role="status" aria-live="polite">{cfMessage}</p>
				{/if}
				{#if workersError}
					<div class="error-row">
						<p class="field-error" role="alert">Couldn't load your Workers. {workersError}</p>
						<AsyncButton size="sm" variant="secondary" action={loadWorkers} pendingLabel="Loading…">Retry</AsyncButton>
					</div>
				{:else if !workers}
					<div class="rows workers" aria-busy="true" aria-label="Loading Workers">
						{#each { length: 3 }, i (i)}<div class="skeleton input-skeleton"></div>{/each}
					</div>
				{:else if workers.length === 0}
					<div class="head">
						<p class="note">This account has no Workers yet.</p>
						<AsyncButton size="sm" variant="secondary" action={loadWorkers} pendingLabel="Refreshing…">Refresh</AsyncButton>
					</div>
				{:else}
					<ul class="rows workers" aria-label="Workers">
						{#each workers as worker (worker.name)}
							<li class="row">
								<label class="worker">
									<input
										type="checkbox"
										checked={worker.subscribed}
										disabled={!worker.repository || !!workerPending[worker.name] || cfBusy !== null}
										onchange={(e) => toggleWorker(worker, e.currentTarget.checked)}
									/>
									<span class="name">{worker.name}</span>
									<span class="detail">
										{#if workerPending[worker.name]}
											Saving…
										{:else if worker.repository}
											{worker.repository.owner}/{worker.repository.name} · {worker.repository.branch}
										{:else}
											No Git repo connected
										{/if}
									</span>
								</label>
								{#if workerErrors[worker.name]}
									<p class="field-error" role="alert">
										Couldn't change {worker.name}. {workerErrors[worker.name]}
									</p>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
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
		{#if update?.available !== false}
			<section aria-labelledby="settings-updates">
				<h2 id="settings-updates">Updates</h2>
				<p class="note">Check GitHub for new ROMP commits and install them now.</p>
				<p class="note">
					Installing waits for running agent turns to finish, then restarts everyone's ROMP, which closes open terminals.
					This page reconnects by itself.
				</p>
				{#if updateLoadError}
					<div class="error-row">
						<p class="field-error" role="alert">Couldn't load the update status. {updateLoadError}</p>
						<AsyncButton size="sm" variant="secondary" action={loadUpdate} pendingLabel="Loading…">Retry</AsyncButton>
					</div>
				{:else if !update}
					<div class="skeleton input-skeleton" aria-busy="true" aria-label="Loading update status"></div>
				{:else}
					<div class="rows">
						<div class="row">
							<div class="head">
								<h3>Installed version</h3>
								{#if update.installed}<code>{update.installed.sha.slice(0, 7)}</code>{/if}
							</div>
							{#if update.installed}
								{#if update.installed.subject}<p>{update.installed.subject}</p>{/if}
								{#if update.installed.at}<p class="meta">Committed {age(update.installed.at)}</p>{/if}
							{:else}
								<p class="note">No install has been recorded yet.</p>
							{/if}
						</div>
					</div>
					<div aria-live="polite" aria-atomic="true">
						{#if update.last}
							<Banner
								tone={UPDATE_TONE[update.last.state]}
								icon={update.last.state === "current" || update.last.state === "updated" ? undefined : Icons.Warn}
								text={`${update.last.message} Checked ${age(update.last.at)}.`}
							/>
						{:else}
							<p class="meta">No update check has run yet.</p>
						{/if}
					</div>
					{#if reloadNeeded && update.installed}
						<div class="head">
							<p>ROMP {update.installed.sha.slice(0, 7)} is installed. Reload to use it.</p>
							<Button size="sm" onclick={() => window.location.reload()}>Reload</Button>
						</div>
					{:else if update.running}
						{#if updateReconnecting}
							<Banner tone="info" text="ROMP is restarting. This page keeps checking and reconnects by itself." />
						{/if}
						<div class="actions">
							<AsyncButton size="sm" pending pendingLabel={updateReconnecting ? "Reconnecting…" : "Updating…"}>
								Update now
							</AsyncButton>
						</div>
					{:else if updateRunError}
						<div class="error-row">
							<p class="field-error" role="alert">Couldn't start the update. {updateRunError}</p>
							<AsyncButton size="sm" variant="secondary" action={runUpdate} pendingLabel="Starting…">Retry</AsyncButton>
						</div>
					{:else}
						<div class="actions">
							<AsyncButton size="sm" action={runUpdate} pendingLabel="Starting…">Update now</AsyncButton>
						</div>
					{/if}
				{/if}
			</section>
		{/if}
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
	section:not(.page) {
		display: grid;
		gap: var(--sp-3);
	}
	/* Rows sit further apart than the lines inside one, and closer than sections. */
	.rows {
		display: grid;
		gap: var(--sp-4);
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
	.token-form {
		display: grid;
		gap: var(--sp-3);
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
			padding-bottom: var(--sp-4);
		}
	}
	.workers {
		gap: var(--sp-2);
		margin: 0;
		padding: 0;
		list-style: none;
		.row:not(:last-child) {
			padding-bottom: var(--sp-2);
		}
	}
	/* Receipt layout: box and name on the left, the repo it builds from on the right. */
	.worker {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--sp-2) var(--sp-3);
		cursor: pointer;
		/* A row, not a field caption: undo the global label's small muted text. */
		font-size: inherit;
		color: var(--fg);
		&:has(input:disabled) {
			cursor: not-allowed;
		}
		input {
			margin: 0;
		}
		.name {
			overflow-wrap: anywhere;
		}
		.detail {
			color: var(--fg-muted);
			font-size: var(--text-sm);
			text-align: end;
			overflow-wrap: anywhere;
		}
	}
	@media (pointer: coarse) {
		.worker {
			grid-template-columns: auto minmax(0, 1fr);
			.detail {
				grid-column: 2;
				text-align: start;
			}
		}
	}
	code {
		display: block;
		overflow-wrap: anywhere;
	}
</style>
