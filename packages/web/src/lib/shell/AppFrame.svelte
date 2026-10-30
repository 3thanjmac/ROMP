<script lang="ts">
	import BottomBar from "./BottomBar.svelte";
	import CommandPalette from "./CommandPalette.svelte";
	import Desk from "./Desk.svelte";
	import LauncherSheet from "./LauncherSheet.svelte";
	import OverviewSheet from "./OverviewSheet.svelte";
	import RenameWorkspaceDialog from "./RenameWorkspaceDialog.svelte";
	import { shell } from "./shell.svelte";
	import ShortcutSheet from "./ShortcutSheet.svelte";
	import TopBar from "./TopBar.svelte";
	import { viewport } from "./viewport.svelte";

	const phone = $derived(viewport.layout === "phone");
</script>

<div class="app" class:phone>
	{#if !phone}<TopBar />{/if}
	<main class="content">
		{#each shell.state.workspaces as ws (ws.id)}
			<Desk {ws} active={ws.id === shell.state.activeWorkspaceId} />
		{/each}
	</main>
	{#if phone && !viewport.keyboardOpen}<BottomBar />{/if}
</div>

{#if phone}
	<LauncherSheet />
	<OverviewSheet />
{:else}
	<CommandPalette />
{/if}
<ShortcutSheet />
<RenameWorkspaceDialog />

<style>
	.app {
		position: fixed;
		inset-inline: 0;
		top: var(--vv-top);
		height: var(--vvh);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.content {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		padding: var(--pane-gap) calc(var(--pane-gap) + var(--safe-right)) calc(var(--pane-gap) + var(--safe-bottom))
			calc(var(--pane-gap) + var(--safe-left));
	}
	.phone .content {
		padding: 0;
	}
</style>
