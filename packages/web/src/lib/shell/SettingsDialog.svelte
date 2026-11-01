<script lang="ts">
	import { Icons } from "../icons";
	import Button from "../ui/Button.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import { shell } from "./shell.svelte";
	import { frameUi } from "./ui.svelte";

	/** One-time setup of the `romp` service user that runs the merge queue. */
	const SETUP = [
		{
			name: "GitHub access",
			action: "Set up GitHub",
			title: "GitHub setup",
			text: "Lets the merge queue push and open pull requests. Choose HTTPS, then let gh authenticate Git.",
			command: ["sudo", "-iu", "romp", "gh", "auth", "login"],
		},
		{
			name: "AI provider",
			action: "Set up AI provider",
			title: "AI provider setup",
			text: "Signs the queue's conflict resolver in to an AI provider and picks its models.",
			command: ["sudo", "-iu", "romp", "omp", "setup"],
		},
	];

	/** Opens a terminal running `command`, or focuses the window that already runs it. Typing goes there: sudo asks first. */
	function run(title: string, command: string[]) {
		frameUi.settings = false;
		const line = command.join(" ");
		if (shell.focusWhere((w) => w.kind === "terminal" && w.props.command?.join(" ") === line, { keyboard: true })) return;
		shell.open({ kind: "terminal", title, props: { command } }, { keyboard: true });
	}
</script>

<Dialog bind:open={frameUi.settings} title="Settings">
	<section aria-labelledby="settings-server-setup">
		<h3 id="settings-server-setup">Server setup</h3>
		<p class="note">Run each once per server, not per person. The terminal asks for your sudo password.</p>
		<div class="rows">
			{#each SETUP as s (s.title)}
				<div class="row">
					<div class="head">
						<h4>{s.name}</h4>
						<Button size="sm" icon={Icons.Terminal} onclick={() => run(s.title, s.command)}>{s.action}</Button>
					</div>
					<p>{s.text}</p>
					<code>{s.command.join(" ")}</code>
				</div>
			{/each}
		</div>
	</section>
	{#snippet footer()}
		<Button onclick={() => (frameUi.settings = false)}>Close</Button>
	{/snippet}
</Dialog>

<style>
	section,
	.rows {
		display: grid;
		gap: var(--sp-3);
	}
	.note,
	code {
		color: var(--fg-muted);
	}
	.row {
		display: grid;
		gap: var(--sp-2);
		&:not(:last-child) {
			border-bottom: var(--border);
			padding-bottom: var(--sp-3);
		}
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-3);
	}
	code {
		display: block;
		overflow-wrap: anywhere;
	}
</style>
