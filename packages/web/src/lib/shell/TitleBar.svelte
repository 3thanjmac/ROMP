<script lang="ts">
	import type { WindowState } from "@romp/protocol";
	import { api, errorMessage } from "../api";
	import { Icons, KIND_ICON } from "../icons";
	import Button from "../ui/Button.svelte";
	import Chip from "../ui/Chip.svelte";
	import ClientCount from "../ui/ClientCount.svelte";
	import ConnDot from "../ui/ConnDot.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import Icon from "../ui/Icon.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuSection from "../ui/MenuSection.svelte";
	import Spinner from "../ui/Spinner.svelte";
	import { toast } from "../ui/toast.svelte";
	import type { PaneStatus } from "./pane.svelte";
	import SaveStatus from "./SaveStatus.svelte";
	import { displayTitle, shell } from "./shell.svelte";
	import { viewport } from "./viewport.svelte";
	import WidthPresetButton from "./WidthPresetButton.svelte";

	interface Props {
		win: WindowState;
		status: PaneStatus;
		focused: boolean;
		/** Scroll mode on tablet/desktop: show the width preset button. */
		showWidth: boolean;
	}

	let { win, status, focused, showWidth }: Props = $props();

	const phone = $derived(viewport.layout === "phone");
	const title = $derived(displayTitle(win));
	const loc = $derived(shell.locate(win.id));
	const others = $derived(shell.state.workspaces.filter((w) => w.id !== loc?.ws.id));

	let renaming = $state(false);
	let draft = $state("");
	let confirmKill = $state(false);

	function startRename() {
		draft = title;
		renaming = true;
	}

	function focusInput(node: HTMLInputElement) {
		node.focus();
		node.select();
	}

	function onRenameKey(e: KeyboardEvent) {
		if (e.key === "Enter") {
			shell.rename(win.id, draft);
			renaming = false;
		} else if (e.key === "Escape") {
			e.stopPropagation();
			renaming = false;
		}
	}

	const killLabel = $derived(win.kind === "terminal" ? "Kill process" : "End session");

	async function kill() {
		try {
			if (win.kind === "terminal" && win.props.termId) await api.terms.kill(win.props.termId);
			if (win.kind === "agent" && win.props.agentId) await api.agents.kill(win.props.agentId);
			confirmKill = false;
		} catch (err) {
			toast({ message: errorMessage(err), tone: "danger" });
		}
	}
</script>

<header class="bar" class:focused class:phone>
	<span class="kind"><Icon icon={KIND_ICON[win.kind]} /></span>
	{#if renaming}
		<input
			class="rename"
			aria-label="Window title"
			bind:value={draft}
			onkeydown={onRenameKey}
			onblur={() => (renaming = false)}
			{@attach focusInput}
		/>
	{:else}
		<span class="title truncate" ondblclick={startRename} role="heading" aria-level="2">{title}</span>
	{/if}

	<span class="right">
		{#if status.needsInput}
			<Chip tone="warning" icon={Icons.Warn}>Needs input</Chip>
		{:else if status.busy}
			<span class="working meta"><Spinner size="sm" />Working</span>
		{/if}
		{#if status.save}
			<SaveStatus state={status.save} onretry={status.retrySave} />
		{/if}
		{#if win.kind === "terminal" || win.kind === "agent"}
			<ClientCount count={status.clients} />
			{#if status.conn}<ConnDot state={status.conn} exitCode={status.exitCode} />{/if}
		{/if}
		{#if showWidth}<WidthPresetButton id={win.id} width={win.width} />{/if}
		<Menu label="Window actions" placement="bottom-end">
			{#snippet trigger(props)}
				<IconButton {...props} size="bar" label="Window actions" icon={Icons.More} />
			{/snippet}
			<MenuItem icon={Icons.Rename} onselect={startRename}>Rename</MenuItem>
			<MenuItem icon={Icons.MoveLeft} disabled={loc?.index === 0} onselect={() => (shell.focus(win.id), shell.moveDir("left"))}>
				Move left
			</MenuItem>
			<MenuItem
				icon={Icons.MoveRight}
				disabled={!loc || loc.index >= loc.ws.windows.length - 1}
				onselect={() => (shell.focus(win.id), shell.moveDir("right"))}
			>
				Move right
			</MenuItem>
			<MenuSection label="Move to workspace" />
			{#each others as ws (ws.id)}
				<MenuItem onselect={() => shell.moveToWorkspaceId(win.id, ws.id)}>{ws.name}</MenuItem>
			{/each}
			<MenuItem icon={Icons.Add} onselect={() => shell.moveToWorkspace(win.id, shell.state.workspaces.length + 1)}>
				New workspace
			</MenuItem>
			<MenuSection label="Window" />
			<MenuItem icon={Icons.Close} onselect={() => shell.close(win.id)}>Close window</MenuItem>
			{#if (win.kind === "terminal" && win.props.termId) || (win.kind === "agent" && win.props.agentId)}
				<MenuItem icon={Icons.Stop} danger disabled={status.conn === "exited"} onselect={() => (confirmKill = true)}>
					{killLabel}
				</MenuItem>
			{/if}
		</Menu>
		{#if !phone}
			<IconButton size="bar" label="Close window" icon={Icons.Close} onclick={() => shell.close(win.id)} />
		{/if}
	</span>
</header>

<Dialog bind:open={confirmKill} title={win.kind === "terminal" ? "Kill this terminal?" : "End this agent session?"}>
	<p class="muted">
		{win.kind === "terminal"
			? "Running programs stop and scrollback is lost."
			: "The agent stops and its process exits. The transcript stays in the session history."}
	</p>
	{#snippet footer()}
		<Button onclick={() => (confirmKill = false)}>Cancel</Button>
		<Button variant="danger" onclick={kill}>{win.kind === "terminal" ? "Kill" : "End session"}</Button>
	{/snippet}
</Dialog>

<style>
	.bar {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		height: var(--titlebar-h);
		padding-inline: var(--sp-2) var(--sp-1);
		background: var(--surface-1);
		border-block-end: var(--border);
		color: var(--fg-muted);
		flex: none;
		transition:
			background var(--dur),
			color var(--dur);
		&.focused {
			background: var(--surface-2);
			color: var(--fg);
		}
		&.phone {
			box-sizing: content-box;
			padding-top: var(--safe-top);
		}
	}
	.kind {
		display: inline-flex;
		color: var(--fg-muted);
	}
	.title {
		flex: 1;
		font-size: var(--text-sm);
		font-weight: 500;
		user-select: none;
	}
	.rename {
		flex: 1;
		min-height: 0;
		padding: 0 var(--sp-2);
		height: calc(var(--titlebar-h) - var(--sp-2));
		font-size: var(--text-sm);
	}
	.right {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		flex: none;
	}
	.working {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
	}
</style>
