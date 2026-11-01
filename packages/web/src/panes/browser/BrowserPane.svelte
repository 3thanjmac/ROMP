<script lang="ts">
	import type { ListeningPort } from "@romp/protocol";
	import { api, errorMessage } from "../../lib/api";
	import { openExternal } from "../../lib/external";
	import { Icons } from "../../lib/icons";
	import type { PaneContext } from "../../lib/shell/pane.svelte";
	import type { WindowOf } from "../../lib/shell/types";
	import Button from "../../lib/ui/Button.svelte";
	import EmptyState from "../../lib/ui/EmptyState.svelte";
	import Icon from "../../lib/ui/Icon.svelte";
	import IconButton from "../../lib/ui/IconButton.svelte";
	import Menu from "../../lib/ui/Menu.svelte";
	import MenuItem from "../../lib/ui/MenuItem.svelte";
	import MenuSection from "../../lib/ui/MenuSection.svelte";
	import Skeleton from "../../lib/ui/Skeleton.svelte";
	import { tooltip } from "../../lib/ui/tooltip";
	import { isAbsolute, normalizeAddress, proxiedPort } from "./address";

	let { win, pane }: { win: WindowOf<"browser">; pane: PaneContext<"browser"> } = $props();

	const BLANK_HINT_MS = 8000;

	const url = $derived(win.props.url);
	const port = $derived(proxiedPort(url));

	let address = $state("");
	let ports: ListeningPort[] | null = $state(null);
	let portsError: string | null = $state(null);
	/** null while checking a proxied port; true when something answers. */
	let alive: boolean | null = $state(null);
	let loading = $state(false);
	let showBlankHint = $state(false);
	let reloadKey = $state(0);

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
</script>

<div class="browser">
	<form class="toolbar" onsubmit={go}>
		<Menu label="Dev servers" onopenchange={(open) => open && void refreshPorts()}>
			{#snippet trigger(props)}
				<button {...props} type="button" class="picker mono" aria-label="Pick a dev server" use:tooltip>
					{#if port !== null}:{port}{:else}<Icon icon={Icons.Browser} />{/if}
					<Icon icon={Icons.ChevronDown} size="xs" />
				</button>
			{/snippet}
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
	<div class="body">
		{#if !url}
			{#if portsError}
				<EmptyState icon={Icons.Warn} title="Couldn't list dev servers" text={portsError}>
					{#snippet actions()}<Button onclick={refreshPorts}>Retry</Button>{/snippet}
				</EmptyState>
			{:else if ports === null}
				<Skeleton preset="rows" count={3} />
			{:else if ports.length === 0}
				<EmptyState
					icon={Icons.Browser}
					title="No dev servers are listening"
					text="Start one in a terminal, then refresh."
				>
					{#snippet actions()}<Button icon={Icons.Reload} onclick={refreshPorts}>Refresh</Button>{/snippet}
				</EmptyState>
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
			<EmptyState icon={Icons.Warn} title="Nothing is listening on :{port}" text="Start the dev server in a terminal, then retry.">
				{#snippet actions()}
					<Button variant="primary" onclick={reload}>Retry</Button>
					<Button onclick={() => pane.setProps({ url: "" })}>Pick another port</Button>
				{/snippet}
			</EmptyState>
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
