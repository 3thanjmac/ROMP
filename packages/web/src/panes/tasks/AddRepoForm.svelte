<script lang="ts">
	import type { RepoInfo } from "@romp/protocol";
	import { api, errorMessage } from "../../lib/api";
	import AsyncButton from "../../lib/ui/AsyncButton.svelte";
	import Button from "../../lib/ui/Button.svelte";

	interface Props {
		onadded: (repo: RepoInfo) => void;
		oncancel?: () => void;
	}

	let { onadded, oncancel }: Props = $props();

	let url = $state("");
	let name = $state("");
	let branch = $state("");
	let error: string | null = $state(null);
	let touched = $state(false);

	async function add() {
		touched = true;
		if (!url.trim()) return;
		error = null;
		try {
			const repo = await api.repos.add({
				url: url.trim(),
				name: name.trim() || undefined,
				branch: branch.trim() || undefined,
			});
			url = name = branch = "";
			touched = false;
			onadded(repo);
		} catch (err) {
			error = errorMessage(err);
		}
	}
</script>

<form class="add" onsubmit={(e) => e.preventDefault()}>
	<label>
		Repository URL
		<input
			bind:value={url}
			required
			aria-invalid={touched && !url.trim()}
			placeholder="https://github.com/you/app.git or git@github.com:you/app.git"
			autocapitalize="off"
			autocomplete="off"
			spellcheck="false"
		/>
	</label>
	<div class="pair">
		<label>
			Name <span class="subtle">(optional)</span>
			<input bind:value={name} autocapitalize="off" autocomplete="off" spellcheck="false" />
		</label>
		<label>
			Branch <span class="subtle">(optional)</span>
			<input bind:value={branch} placeholder="main" autocapitalize="off" autocomplete="off" spellcheck="false" />
		</label>
	</div>
	{#if error}<p class="field-error">{error}</p>{/if}
	<div class="actions">
		{#if oncancel}<Button onclick={oncancel}>Cancel</Button>{/if}
		<AsyncButton variant="primary" action={add} pendingLabel="Cloning…">Add repo</AsyncButton>
	</div>
</form>

<style>
	.add {
		display: grid;
		gap: var(--sp-3);
		width: 100%;
		text-align: start;
	}
	.pair {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
		gap: var(--sp-3);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
	}
</style>
