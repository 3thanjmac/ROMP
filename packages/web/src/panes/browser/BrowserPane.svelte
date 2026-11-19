<script lang="ts">
	import type { DevCommand, DevServerInfo, ListeningPort } from "@romp/protocol";
	import { tick, untrack } from "svelte";
	import { api, ApiFailure, errorMessage } from "../../lib/api";
	import { openExternal } from "../../lib/external";
	import { Icons } from "../../lib/icons";
	import type { PaneContext } from "../../lib/shell/pane.svelte";
	import { shell } from "../../lib/shell/shell.svelte";
	import type { WindowOf } from "../../lib/shell/types";
	import AsyncButton from "../../lib/ui/AsyncButton.svelte";
	import Button from "../../lib/ui/Button.svelte";
	import EmptyState from "../../lib/ui/EmptyState.svelte";
	import Icon from "../../lib/ui/Icon.svelte";
	import IconButton from "../../lib/ui/IconButton.svelte";
	import Menu from "../../lib/ui/Menu.svelte";
	import MenuItem from "../../lib/ui/MenuItem.svelte";
	import MenuSection from "../../lib/ui/MenuSection.svelte";
	import Skeleton from "../../lib/ui/Skeleton.svelte";
	import { toast } from "../../lib/ui/toast.svelte";
	import { tooltip } from "../../lib/ui/tooltip";
	import { isAbsolute, normalizeAddress, proxiedPort } from "./address";

	let { win, pane }: { win: WindowOf<"browser">; pane: PaneContext<"browser"> } = $props();

	const BLANK_HINT_MS = 8000;
	const STARTING_POLL_MS = 1000;
	/** While ready, a slower poll notices the server exiting under the preview. */
	const READY_POLL_MS = 5000;

	const url = $derived(win.props.url);
	const port = $derived(proxiedPort(url));
	const cwd = $derived(win.props.cwd);

	let address = $state("");
	let ports: ListeningPort[] | null = $state(null);
	let portsError: string | null = $state(null);
	/** null while checking a proxied port; true when something answers. */
	let alive: boolean | null = $state(null);
	let loading = $state(false);
	let showBlankHint = $state(false);
	let reloadKey = $state(0);

	/** What Start would run here; null until loaded. */
	let devCommand = $state<DevCommand | null>(null);
	let devError: string | null = $state(null);
	/** The gateway's dev server for this folder, the authority on its state. */
	let server = $state<DevServerInfo | null>(null);
	/** Server this window started (or found starting); only its ready loads the preview, and only once. */
	let attempt: string | null = $state(null);
	let navigated: string | null = null;
	let mutation: "start" | "stop" | null = $state(null);
	let startError: string | null = $state(null);
	let now = $state(Date.now());
	let body: HTMLDivElement | undefined = $state();

	/** The current attempt's server: drives the starting and exited screens. */
	const current = $derived(server && server.id === attempt ? server : null);
	const command = $derived(server?.command ?? devCommand?.command ?? null);
	const elapsed = $derived(server ? Math.max(0, Math.floor((now - server.startedAt) / 1000)) : 0);

	$effect(() => {
		address = url;
	});

	$effect(() => {
		pane.status.subtitle = url || null;
	});

	async function refreshPorts() {
		portsError = null;
		try {
			ports = await api.ports.list();
		} catch (err) {
			portsError = errorMessage(err);
		}
	}

	$effect(() => {
		if (!url) void refreshPorts();
	});

	// Probe a proxied port before loading it, so a dead dev server gets a real explanation, not a blank frame.
	$effect(() => {
		const target = url;
		void reloadKey;
		if (!target) return;
		loading = true;
		showBlankHint = false;
		if (port === null) {
			alive = true;
			const hint = isAbsolute(target) ? window.setTimeout(() => (showBlankHint = loading), BLANK_HINT_MS) : undefined;
			return () => clearTimeout(hint);
		}
		alive = null;
		const ac = new AbortController();
		fetch(target, { method: "HEAD", signal: ac.signal, cache: "no-store" }).then(
			(res) => (alive = res.status !== 502 && res.status !== 503 && res.status !== 504),
			() => !ac.signal.aborted && (alive = false),
		);
		return () => ac.abort();
	});

	function go(e: SubmitEvent) {
		e.preventDefault();
		const next = normalizeAddress(address);
		if (!next) return;
		if (next === url) reloadKey++;
		else pane.setProps({ url: next });
	}

	function pick(p: number) {
		pane.setProps({ url: `/proxy/${p}/` });
	}

	function reload() {
		reloadKey++;
	}

	function external() {
		if (url) openExternal(url);
	}

	function apply(next: DevServerInfo | null) {
		server = next;
		if (!next || next.id !== attempt || next.state !== "ready" || next.port === null || navigated === next.id) return;
		navigated = next.id;
		if (url === `/proxy/${next.port}/`) reload();
		else pick(next.port);
	}

	async function refreshDev() {
		const dir = cwd;
		if (!dir) return;
		devError = null;
		try {
			const [cmd, servers] = await Promise.all([api.dev.command(dir), api.dev.list()]);
			if (dir !== cwd) return;
			devCommand = cmd;
			const found = servers.find((s) => s.id === attempt) ?? servers.find((s) => s.cwd === cmd.cwd) ?? null;
			// A server started elsewhere (another window, another device) is followed when this window shows nothing.
			if (found?.state === "starting" && attempt === null && !url) attempt = found.id;
			apply(found);
		} catch (err) {
			devError = errorMessage(err);
		}
	}

	// On open, and whenever the window gains or loses focus (settings or another window may have changed things).
	$effect(() => {
		void pane.focused;
		if (cwd) untrack(() => void refreshDev());
	});

	// Tasks Preview asks for a start through the window's props.
	$effect(() => {
		if (!win.props.start || !cwd) return;
		pane.setProps({ start: undefined });
		untrack(() => void startDev());
	});

	$effect(() => {
		const s = server;
		if (!s || s.state === "exited" || (s.state === "ready" && !pane.visible)) return;
		const timer = window.setTimeout(
			async () => {
				try {
					const servers = await api.dev.list();
					if (server === s) apply(servers.find((x) => x.id === s.id) ?? null);
				} catch {
					// Unreachable for now: poll again on the next tick.
					if (server === s) server = { ...s };
				}
			},
			s.state === "starting" ? STARTING_POLL_MS : READY_POLL_MS,
		);
		return () => clearTimeout(timer);
	});

	$effect(() => {
		if (server?.state !== "starting") return;
		now = Date.now();
		const timer = window.setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	async function startDev() {
		const dir = cwd;
		if (!dir || mutation) return;
		// The Start button is about to be replaced by the starting screen: keep focus from falling to the page.
		const refocus = body?.contains(document.activeElement) ?? false;
		mutation = "start";
		startError = null;
		try {
			const info = await api.dev.start(dir);
			attempt = info.id;
			navigated = null;
			apply(info);
		} catch (err) {
			if (err instanceof ApiFailure && err.body.error === "no_dev_command") {
				if (devCommand) devCommand = { ...devCommand, command: null };
				else void refreshDev();
			} else {
				startError = errorMessage(err);
			}
		} finally {
			mutation = null;
		}
		if (refocus && current?.state === "starting") {
			await tick();
			const heading = body?.querySelector("h3");
			if (heading) {
				heading.tabIndex = -1;
				heading.focus({ preventScroll: true });
			}
		}
	}

	/** Stop (or Cancel while starting) returns to idle; the exit it causes is not a failure. */
	async function stopDev() {
		const target = server;
		if (!target || mutation) return;
		mutation = "stop";
		try {
			await api.dev.stop(target.id);
			settleStopped(target);
		} catch (err) {
			if (err instanceof ApiFailure && err.status === 404) settleStopped(target);
			else toast({ message: `Couldn't stop the dev server: ${errorMessage(err)}`, tone: "danger" });
		} finally {
			mutation = null;
		}
	}

	/** Back to idle; a preview of the stopped server is cleared so its last page doesn't linger in the frame. */
	function settleStopped(stopped: DevServerInfo) {
		if (server?.id === stopped.id) server = null;
		if (attempt === stopped.id) attempt = null;
		startError = null;
		if (stopped.port !== null && port === stopped.port) pane.setProps({ url: "" });
	}

	/** Focuses the terminal window already showing the server's logs, or attaches a new one to its session. */
	function showLogs() {
		const s = server;
		if (!s) return;
		if (!shell.focusWhere((w) => w.kind === "terminal" && w.props.termId === s.termId, { keyboard: true })) {
			shell.open({ kind: "terminal", props: { termId: s.termId, cwd: s.cwd } }, { keyboard: true });
		}
	}

	/** Opens the owning repo's settings at its Dev command, in the Tasks window (one is opened when there is none). */
	function setDevCommand() {
		const repo = devCommand?.repo;
		if (!repo) return;
		const tasks = shell.find((w) => w.kind === "tasks");
		if (tasks) {
			shell.setProps(tasks.id, { settings: repo });
			shell.focus(tasks.id);
		} else {
			shell.open({ kind: "tasks", props: { settings: repo } });
		}
	}
</script>

<div class="browser">
	<form class="toolbar" onsubmit={go}>
		<Menu label="Dev servers" onopenchange={(open) => open && (void refreshPorts(), void refreshDev())}>
			{#snippet trigger(props)}
				<button {...props} type="button" class="picker mono" aria-label="Pick a dev server" use:tooltip>
					{#if port !== null}:{port}{:else}<Icon icon={Icons.Browser} />{/if}
					<Icon icon={Icons.ChevronDown} size="xs" />
				</button>
			{/snippet}
			{#if cwd}
				<MenuSection label="This folder" />
				{#if server && server.state !== "exited"}
					<MenuItem disabled onselect={() => {}}>
						{server.state === "starting" ? `Starting… ${elapsed}s` : `Ready on :${server.port}`}
					</MenuItem>
					<MenuItem icon={Icons.Stop} disabled={mutation !== null} onselect={() => void stopDev()}>
						{mutation === "stop" ? "Stopping…" : "Stop dev server"}
					</MenuItem>
					<MenuItem icon={Icons.Terminal} onselect={showLogs}>Show logs</MenuItem>
				{:else if devError && !server}
					<MenuItem disabled onselect={() => {}}>{devError}</MenuItem>
				{:else if devCommand === null && !server}
					<MenuItem disabled onselect={() => {}}>Loading…</MenuItem>
				{:else if command === null}
					<MenuItem disabled onselect={() => {}}>No dev command found</MenuItem>
					{#if devCommand?.repo}
						<MenuItem icon={Icons.Settings} onselect={setDevCommand}>Set dev command</MenuItem>
					{/if}
				{:else}
					<MenuItem disabled onselect={() => {}}>
						{#if server}
							{server.exitCode === null ? "Dev server exited" : `Exited with code ${server.exitCode}`}
						{:else}
							<span class="mono truncate" use:tooltip={command}>{command}</span>
						{/if}
					</MenuItem>
					<MenuItem icon={Icons.Browser} disabled={mutation !== null} onselect={() => void startDev()}>
						{mutation === "start" ? "Starting…" : "Start dev server"}
					</MenuItem>
					{#if server}<MenuItem icon={Icons.Terminal} onselect={showLogs}>Show logs</MenuItem>{/if}
				{/if}
			{/if}
			<MenuSection label="Listening ports" />
			{#if ports === null && !portsError}
				<MenuItem disabled onselect={() => {}}>Loading…</MenuItem>
			{:else if portsError}
				<MenuItem disabled onselect={() => {}}>{portsError}</MenuItem>
			{:else if ports && ports.length === 0}
				<MenuItem disabled onselect={() => {}}>Nothing is listening</MenuItem>
			{:else if ports}
				{#each ports as p (p.port)}
					<MenuItem checked={p.port === port} onselect={() => pick(p.port)}>
						{p.process ?? "unknown"}
						{#snippet trailing()}<span class="mono">:{p.port}</span>{/snippet}
					</MenuItem>
				{/each}
			{/if}
			<MenuSection label="Actions" />
			<MenuItem icon={Icons.Reload} onselect={() => void refreshPorts()}>Refresh list</MenuItem>
		</Menu>
		<IconButton size="bar" label="Reload" icon={Icons.Reload} disabled={!url} onclick={reload} />
		<input
			class="address mono"
			bind:value={address}
			aria-label="Address"
			placeholder="5173, /proxy/5173/ or https://…"
			autocapitalize="off"
			autocomplete="off"
			spellcheck="false"
			enterkeyhint="go"
		/>
		<IconButton size="bar" label="Open in new tab" icon={Icons.External} disabled={!url} onclick={external} />
	</form>
	{#if loading && alive}<div class="progress" aria-hidden="true"></div>{/if}
	{#if showBlankHint}
		<p class="hint meta">If this stays blank, the site refuses to be embedded. Open it in a new tab.</p>
	{/if}
	<div class="body" bind:this={body}>
		{#if startError && !(url && alive)}
			<EmptyState icon={Icons.Warn} title="Couldn't start the dev server" text={startError}>
				{#snippet actions()}
					<AsyncButton icon={Icons.Reload} pendingLabel="Starting…" action={startDev}>Retry</AsyncButton>
					{#if server}<Button icon={Icons.Terminal} onclick={showLogs}>Show logs</Button>{/if}
				{/snippet}
			</EmptyState>
		{:else if current?.state === "starting"}
			<EmptyState icon={Icons.Browser} title="Starting dev server…">
				<p class="muted" aria-live="polite">{current.command} · {elapsed}s elapsed. This can take up to a minute.</p>
				{#snippet actions()}
					<Button icon={Icons.Terminal} onclick={showLogs}>Show logs</Button>
					<Button disabled={mutation === "stop"} onclick={stopDev}>{mutation === "stop" ? "Cancelling…" : "Cancel"}</Button>
				{/snippet}
			</EmptyState>
		{:else if current?.state === "exited"}
			<EmptyState
				icon={Icons.Warn}
				title={current.exitCode === null ? "Dev server exited." : `Dev server exited (code ${current.exitCode}).`}
				text="Check the logs, then try again."
			>
				{#snippet actions()}
					<AsyncButton icon={Icons.Reload} pendingLabel="Starting…" action={startDev}>Retry</AsyncButton>
					<Button icon={Icons.Terminal} onclick={showLogs}>Show logs</Button>
				{/snippet}
			</EmptyState>
		{:else if !url}
			{#if portsError}
				<EmptyState icon={Icons.Warn} title="Couldn't list dev servers" text={portsError}>
					{#snippet actions()}<Button onclick={refreshPorts}>Retry</Button>{/snippet}
				</EmptyState>
			{:else if ports === null}
				<Skeleton preset="rows" count={3} />
			{:else if ports.length === 0}
				{#if command}
					<EmptyState icon={Icons.Browser} title="No dev servers are listening" text="Start {command} in this folder.">
						{#snippet actions()}
							<AsyncButton pendingLabel="Starting…" action={startDev}>Start dev server</AsyncButton>
							<Button icon={Icons.Reload} onclick={refreshPorts}>Refresh</Button>
						{/snippet}
					</EmptyState>
				{:else if devCommand}
					<EmptyState icon={Icons.Browser} title="No dev servers are listening" text="No dev command was found for this folder.">
						{#snippet actions()}
							{#if devCommand?.repo}
								<Button variant="primary" icon={Icons.Settings} onclick={setDevCommand}>Set dev command</Button>
							{/if}
							<Button icon={Icons.Reload} onclick={refreshPorts}>Refresh</Button>
						{/snippet}
					</EmptyState>
				{:else}
					<EmptyState
						icon={Icons.Browser}
						title="No dev servers are listening"
						text="Start one in a terminal, then refresh."
					>
						{#snippet actions()}<Button icon={Icons.Reload} onclick={refreshPorts}>Refresh</Button>{/snippet}
					</EmptyState>
				{/if}
			{:else}
				<EmptyState icon={Icons.Browser} title="Pick a dev server">
					{#snippet actions()}
						{#each ports as p (p.port)}
							<Button onclick={() => pick(p.port)}><span class="mono">:{p.port}</span>{p.process ? ` · ${p.process}` : ""}</Button>
						{/each}
					{/snippet}
				</EmptyState>
			{/if}
		{:else if alive === null}
			<Skeleton preset="blocks" count={2} />
		{:else if alive === false}
			{#if command}
				<EmptyState
					icon={Icons.Warn}
					title="Nothing is listening on :{port}"
					text="Start {command} for this folder, or retry the current address."
				>
					{#snippet actions()}
						<AsyncButton pendingLabel="Starting…" action={startDev}>Start dev server</AsyncButton>
						<Button onclick={reload}>Retry</Button>
						<Button variant="ghost" onclick={() => pane.setProps({ url: "" })}>Pick another port</Button>
					{/snippet}
				</EmptyState>
			{:else if devCommand}
				<EmptyState icon={Icons.Warn} title="Nothing is listening on :{port}" text="No dev command was found for this folder.">
					{#snippet actions()}
						{#if devCommand?.repo}
							<Button variant="primary" icon={Icons.Settings} onclick={setDevCommand}>Set dev command</Button>
						{/if}
						<Button onclick={reload}>Retry</Button>
						<Button variant="ghost" onclick={() => pane.setProps({ url: "" })}>Pick another port</Button>
					{/snippet}
				</EmptyState>
			{:else}
				<EmptyState icon={Icons.Warn} title="Nothing is listening on :{port}" text="Start the dev server in a terminal, then retry.">
					{#snippet actions()}
						<Button variant="primary" onclick={reload}>Retry</Button>
						<Button onclick={() => pane.setProps({ url: "" })}>Pick another port</Button>
					{/snippet}
				</EmptyState>
			{/if}
		{:else}
			{#key `${url}#${reloadKey}`}
				<iframe
					src={url}
					title={url}
					onload={() => {
						loading = false;
						showBlankHint = false;
					}}
				></iframe>
			{/key}
		{/if}
	</div>
</div>

<style>
	.browser {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		position: relative;
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		height: var(--toolbar-h);
		padding-inline: var(--sp-1);
		border-block-end: var(--border);
		flex: none;
	}
	.picker {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		height: calc(var(--toolbar-h) - var(--sp-2));
		padding: 0 var(--sp-2);
		border-radius: var(--radius-sm);
		font-size: var(--text-sm);
		color: var(--fg);
		flex: none;
		&:hover,
		&[aria-expanded="true"] {
			background: var(--surface-3);
		}
	}
	.address {
		flex: 1;
		min-width: var(--address-min);
		min-height: 0;
		height: calc(var(--toolbar-h) - var(--sp-2));
		padding-block: 0;
		font-size: var(--text-sm);
	}
	.progress {
		position: absolute;
		top: var(--toolbar-h);
		left: 0;
		height: var(--progress-h);
		width: 0;
		background: var(--accent);
		z-index: var(--z-banner);
		animation: grow 8s var(--ease) forwards;
	}
	@keyframes grow {
		to {
			width: 90%;
		}
	}
	.hint {
		padding: var(--sp-1) var(--sp-3);
		border-block-end: var(--border);
	}
	.body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		background: var(--surface-1);
	}
	iframe {
		flex: 1;
		width: 100%;
		border: 0;
		background: var(--surface-1);
	}
</style>
