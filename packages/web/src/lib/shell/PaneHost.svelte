<script lang="ts">
	import type { WindowState } from "@romp/protocol";
	import AgentPane from "../../panes/agent/AgentPane.svelte";
	import BrowserPane from "../../panes/browser/BrowserPane.svelte";
	import EditorPane from "../../panes/editor/EditorPane.svelte";
	import FilesPane from "../../panes/files/FilesPane.svelte";
	import TasksPane from "../../panes/tasks/TasksPane.svelte";
	import TerminalPane from "../../panes/terminal/TerminalPane.svelte";
	import type { PaneContext } from "./pane.svelte";

	let { win, pane }: { win: WindowState; pane: PaneContext } = $props();
</script>

{#if win.kind === "terminal"}
	<TerminalPane {win} pane={pane as PaneContext<"terminal">} />
{:else if win.kind === "files"}
	<FilesPane {win} pane={pane as PaneContext<"files">} />
{:else if win.kind === "editor"}
	<EditorPane {win} pane={pane as PaneContext<"editor">} />
{:else if win.kind === "agent"}
	<AgentPane {win} pane={pane as PaneContext<"agent">} />
{:else if win.kind === "browser"}
	<BrowserPane {win} pane={pane as PaneContext<"browser">} />
{:else if win.kind === "tasks"}
	<TasksPane {win} pane={pane as PaneContext<"tasks">} />
{/if}
