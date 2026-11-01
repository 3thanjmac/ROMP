<script lang="ts">
	import { tildify, untildify } from "../format";
	import { Icons } from "../icons";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Sheet from "../ui/Sheet.svelte";
	import { LAUNCH_ITEMS, launch, launchCwd, type LaunchKind } from "./launcherItems";
	import { session } from "./session.svelte";
	import { frameUi } from "./ui.svelte";

	let cwd = $state("");
	/** "cwd" edits the directory chip; "file" asks for the path of a file to open. */
	let editing: "cwd" | "file" | null = $state(null);
	let draft = $state("");

	$effect(() => {
		if (frameUi.launcher) {
			cwd = launchCwd();
			editing = null;
		}
	});

	const home = $derived(session.me?.home);

	function pick(kind: LaunchKind) {
		if (kind === "open-file") {
			draft = `${tildify(cwd, home)}/`;
			editing = "file";
			return;
		}
		launch(kind, cwd);
		frameUi.launcher = false;
	}

	function submit(e: SubmitEvent) {
		e.preventDefault();
		const path = untildify(draft.trim(), home);
		if (!path) return;
		if (editing === "file") {
			launch("open-file", path);
			frameUi.launcher = false;
		} else {
			cwd = path.replace(/(.)\/+$/, "$1");
			editing = null;
		}
	}

	function focusInput(node: HTMLInputElement) {
		node.focus();
	}
</script>

<Sheet bind:open={frameUi.launcher} label="New window">
	<div class="launcher">
		{#if editing}
			<form onsubmit={submit}>
				<label>
					{editing === "file" ? "File path" : "Start in"}
					<input class="mono" bind:value={draft} required autocapitalize="off" autocomplete="off" spellcheck="false" {@attach focusInput} />
				</label>
				<div class="actions">
					<Button variant="ghost" onclick={() => (editing = null)}>Cancel</Button>
					<Button variant="primary" type="submit">{editing === "file" ? "Open" : "Use folder"}</Button>
				</div>
			</form>
		{:else}
			<button class="cwd meta mono truncate" onclick={() => ((draft = tildify(cwd, home)), (editing = "cwd"))}>
				in {tildify(cwd, home)}
			</button>
		{/if}
		<div class="grid">
			{#each LAUNCH_ITEMS as item (item.kind)}
				<button class="tile" onclick={() => pick(item.kind)}>
					<Icon icon={item.icon} size="lg" />
					<span>{item.label}</span>
				</button>
			{/each}
		</div>
	</div>
</Sheet>

<style>
	.launcher {
		display: grid;
		gap: var(--sp-3);
	}
	.cwd {
		justify-self: start;
		max-width: 100%;
		padding: var(--sp-1) var(--sp-2);
		border-radius: var(--radius-full);
		background: var(--surface-2);
		border: var(--border);
	}
	form {
		display: grid;
		gap: var(--sp-2);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: var(--sp-2);
	}
	.tile {
		display: grid;
		justify-items: center;
		align-content: center;
		gap: var(--sp-1);
		min-height: var(--tile-h);
		padding: var(--sp-2);
		border-radius: var(--radius-lg);
		background: var(--surface-2);
		font-size: var(--text-sm);
		color: var(--fg);
		transition: background var(--dur-fast);
		:global(.icon) {
			color: var(--fg-muted);
		}
		&:hover,
		&:active {
			background: var(--surface-3);
		}
	}
</style>
