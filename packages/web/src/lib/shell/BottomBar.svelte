<script lang="ts">
	import { net } from "../conn/net.svelte";
	import { Icons } from "../icons";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuSection from "../ui/MenuSection.svelte";
	import { tooltip } from "../ui/tooltip";
	import { paneStatuses } from "./pane.svelte";
	import { shell } from "./shell.svelte";
	import { frameUi } from "./ui.svelte";

	const ws = $derived(shell.active);
	const index = $derived(ws.windows.findIndex((w) => w.id === ws.focusedId));
	const needsInput = $derived(ws.windows.some((w) => paneStatuses.get(w.id)?.needsInput));
	const modeLabel = $derived(
		ws.mode === "scroll" ? "Layout: scroll. Switch to tile" : "Layout: tile. Switch to scroll",
	);
</script>

<nav class="bottombar" aria-label="Shell">
	<Menu label="Workspaces" placement="top-start">
		{#snippet trigger(props)}
			<button {...props} class="item ws">
				<span class="truncate name">{ws.name}</span>
				<Icon icon={Icons.ChevronUp} size="sm" />
				{#if net.offline}<span class="offline" role="img" aria-label="Offline"><Icon icon={Icons.Offline} size="sm" /></span>{/if}
			</button>
		{/snippet}
		<MenuSection label="Workspaces" />
		{#each shell.state.workspaces as w (w.id)}
			<MenuItem checked={w.id === ws.id} onselect={() => shell.switchWorkspace(w.id)}>
				{w.name}
				{#snippet trailing()}{w.windows.length}{/snippet}
			</MenuItem>
		{/each}
		<MenuSection label="Workspace" />
		<MenuItem icon={Icons.Add} onselect={() => shell.addWorkspace()}>New workspace</MenuItem>
		<MenuItem icon={Icons.Rename} onselect={() => (frameUi.renameWorkspace = ws.id)}>Rename…</MenuItem>
	</Menu>

	<button class="item" aria-label="Overview" onclick={() => (frameUi.overview = true)} use:tooltip>
		<span class="glyph">
			<Icon icon={Icons.Overview} size="lg" />
			{#if needsInput}<span class="attention" aria-hidden="true"></span>{/if}
		</span>
		<span class="tabular count">{ws.windows.length ? `${index + 1}/${ws.windows.length}` : "0"}</span>
	</button>

	<button class="item" aria-label={modeLabel} onclick={() => shell.toggleMode()} use:tooltip>
		<Icon icon={ws.mode === "scroll" ? Icons.ModeScroll : Icons.ModeTile} size="lg" />
	</button>

	<button class="launch" aria-label="New window" onclick={() => (frameUi.launcher = true)} use:tooltip>
		<Icon icon={Icons.Add} size="lg" />
	</button>
</nav>

<style>
	.bottombar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-2);
		height: calc(var(--bottombar-h) + var(--safe-bottom));
		padding: 0 calc(var(--sp-2) + var(--safe-right)) var(--safe-bottom) calc(var(--sp-2) + var(--safe-left));
		background: var(--surface-2);
		border-block-start: var(--border);
		z-index: var(--z-bar);
		flex: none;
	}
	.item {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--sp-1);
		min-width: var(--tap);
		height: var(--tap);
		padding: 0 var(--sp-2);
		border-radius: var(--radius-md);
		color: var(--fg-muted);
		&:active,
		&[aria-expanded="true"] {
			background: var(--surface-3);
			color: var(--fg);
		}
	}
	.ws {
		color: var(--fg);
		font-weight: 500;
		.name {
			max-width: var(--ws-name-max);
		}
	}
	.offline {
		display: inline-flex;
		color: var(--warning);
	}
	.glyph {
		position: relative;
		display: inline-flex;
	}
	.attention {
		position: absolute;
		top: 0;
		right: 0;
		width: var(--dot-sm);
		height: var(--dot-sm);
		border-radius: var(--radius-full);
		background: var(--warning);
	}
	.count {
		font-size: var(--text-sm);
	}
	.launch {
		display: inline-grid;
		place-items: center;
		width: var(--tap);
		height: var(--tap);
		border-radius: var(--radius-full);
		background: var(--accent);
		color: var(--accent-fg);
		transition: background var(--dur-fast);
		&:active {
			background: oklch(from var(--accent) calc(l + var(--active-l)) c h);
		}
	}
</style>
