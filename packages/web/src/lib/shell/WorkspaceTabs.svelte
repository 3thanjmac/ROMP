<script lang="ts">
	import { Icons } from "../icons";
	import IconButton from "../ui/IconButton.svelte";
	import { shell } from "./shell.svelte";

	let editing: string | null = $state(null);
	let draft = $state("");

	function startRename(id: string, name: string) {
		draft = name;
		editing = id;
	}

	function commit() {
		if (editing) shell.renameWorkspace(editing, draft);
		editing = null;
	}

	function focusInput(node: HTMLInputElement) {
		node.focus();
		node.select();
	}
</script>

<div class="tabs" role="tablist" aria-label="Workspaces">
	{#each shell.state.workspaces as ws, i (ws.id)}
		{#if editing === ws.id}
			<input
				class="edit"
				aria-label="Workspace name"
				bind:value={draft}
				onkeydown={(e) => {
					if (e.key === "Enter") commit();
					else if (e.key === "Escape") editing = null;
				}}
				onblur={commit}
				{@attach focusInput}
			/>
		{:else}
			<button
				role="tab"
				class="tab"
				aria-selected={ws.id === shell.state.activeWorkspaceId}
				onclick={() => shell.switchWorkspace(ws.id)}
				ondblclick={() => startRename(ws.id, ws.name)}
			>
				<span class="meta tabular">{i + 1}</span>
				<span class="truncate">{ws.name}</span>
			</button>
		{/if}
	{/each}
	<IconButton size="sm" label="New workspace" icon={Icons.Add} onclick={() => shell.addWorkspace()} />
</div>

<style>
	.tabs {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.tab {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		height: var(--tab-h);
		max-width: var(--crumb-max);
		padding: 0 var(--sp-2);
		border-radius: var(--radius-sm);
		color: var(--fg-muted);
		font-size: var(--text-sm);
		font-weight: 500;
		flex: none;
		transition:
			background var(--dur-fast),
			color var(--dur-fast);
		&:hover {
			background: var(--surface-3);
			color: var(--fg);
		}
		&[aria-selected="true"] {
			background: var(--surface-3);
			color: var(--fg);
		}
	}
	.edit {
		height: var(--tab-h);
		min-height: 0;
		width: var(--crumb-max);
		padding: 0 var(--sp-2);
		font-size: var(--text-sm);
	}
</style>
