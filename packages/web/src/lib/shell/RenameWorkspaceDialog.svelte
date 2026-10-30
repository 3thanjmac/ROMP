<script lang="ts">
	import Button from "../ui/Button.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import { shell } from "./shell.svelte";
	import { frameUi } from "./ui.svelte";

	let name = $state("");
	let open = $state(false);

	$effect(() => {
		const id = frameUi.renameWorkspace;
		open = id !== null;
		if (id) name = shell.state.workspaces.find((w) => w.id === id)?.name ?? "";
	});

	function submit(e: SubmitEvent) {
		e.preventDefault();
		if (frameUi.renameWorkspace) shell.renameWorkspace(frameUi.renameWorkspace, name);
		frameUi.renameWorkspace = null;
	}
</script>

<Dialog bind:open title="Rename workspace" onclose={() => (frameUi.renameWorkspace = null)}>
	<form id="rename-ws" onsubmit={submit}>
		<label>
			Name
			<input bind:value={name} required maxlength="40" autocomplete="off" />
		</label>
	</form>
	{#snippet footer()}
		<Button onclick={() => (frameUi.renameWorkspace = null)}>Cancel</Button>
		<Button variant="primary" type="submit" form="rename-ws">Rename</Button>
	{/snippet}
</Dialog>
