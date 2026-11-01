<script lang="ts">
	import Toaster from "./lib/ui/Toaster.svelte";
	import Skeleton from "./lib/ui/Skeleton.svelte";
	import AppFrame from "./lib/shell/AppFrame.svelte";
	import LoginScreen from "./lib/shell/LoginScreen.svelte";
	import { signIn } from "./lib/conn/signin.svelte";
	import { installShortcuts, type ShellAction } from "./lib/shell/keyboard";
	import { launch, launchCwd } from "./lib/shell/launcherItems";
	import { initPersistence, persistence } from "./lib/shell/persist.svelte";
	import { loadMe } from "./lib/shell/session.svelte";
	import { shell } from "./lib/shell/shell.svelte";
	import { frameUi } from "./lib/shell/ui.svelte";
	import { viewport } from "./lib/shell/viewport.svelte";

	void loadMe();
	void initPersistence();

	function run(action: ShellAction): boolean {
		// Workspace shortcuts would edit a layout that is not on screen.
		if (signIn.required || frameUi.settings) return false;
		const focused = shell.active.focusedId;
		switch (action.type) {
			case "focus":
				shell.focusDir(action.dir);
				break;
			case "move":
				shell.moveDir(action.dir);
				break;
			case "resize":
				shell.resizeFocused(action.dir);
				break;
			case "cycleWidth":
				shell.cycleWidth();
				break;
			case "toggleFull":
				shell.toggleFull();
				break;
			case "launcher":
				if (viewport.layout === "phone") frameUi.launcher = !frameUi.launcher;
				else frameUi.palette = !frameUi.palette;
				break;
			case "newTerminal":
				launch("terminal", launchCwd(), true);
				break;
			case "close":
				if (focused) shell.close(focused);
				break;
			case "toggleMode":
				shell.toggleMode();
				break;
			case "workspace":
				shell.switchToNumber(action.n);
				break;
			case "moveToWorkspace":
				if (focused) shell.moveToWorkspace(focused, action.n);
				break;
			case "cycleWorkspace":
				shell.cycleWorkspace(action.delta);
				break;
			case "shortcuts":
				frameUi.shortcuts = true;
				break;
		}
		return true;
	}

	$effect(() => installShortcuts(run));
</script>

{#if signIn.required}
	<LoginScreen />
{:else if persistence.ready}
	<AppFrame />
{:else}
	<div class="boot"><Skeleton preset="rows" count={4} note="Loading your workspace…" /></div>
{/if}
<Toaster />

<style>
	.boot {
		position: fixed;
		inset: 0;
		display: grid;
		align-content: center;
		justify-content: center;
		width: min(var(--dialog-w), 100vw);
		margin-inline: auto;
	}
</style>
