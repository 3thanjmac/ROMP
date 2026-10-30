<script lang="ts">
	/** Inline name field for new files/folders and renames. Enter commits, Esc cancels. */
	import type { IconComponent } from "../../lib/icons";
	import Icon from "../../lib/ui/Icon.svelte";
	import { validName } from "./fileKind";

	interface Props {
		icon: IconComponent;
		value: string;
		label: string;
		/** Server error from the last attempt; the field stays open with the typed value. */
		error?: string | null;
		oncommit: (name: string) => void;
		oncancel: () => void;
	}

	let { icon, value = $bindable(), label, error = null, oncommit, oncancel }: Props = $props();

	let touched = $state(false);
	const invalid = $derived(touched && !validName(value));

	function focus(node: HTMLInputElement) {
		node.focus();
		const dot = node.value.lastIndexOf(".");
		node.setSelectionRange(0, dot > 0 ? dot : node.value.length);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			oncancel();
		} else if (e.key === "Enter") {
			e.preventDefault();
			touched = true;
			if (validName(value)) oncommit(value.trim());
		}
	}
</script>

<div class="name-row">
	<Icon {icon} />
	<div class="field">
		<input
			bind:value
			aria-label={label}
			aria-invalid={invalid || !!error}
			required
			autocapitalize="off"
			autocomplete="off"
			spellcheck="false"
			{onkeydown}
			onblur={() => (touched = true)}
			{@attach focus}
		/>
		{#if invalid}
			<p class="field-error">{value.includes("/") ? "Names can't contain /" : "Enter a name"}</p>
		{:else if error}
			<p class="field-error">{error}</p>
		{/if}
	</div>
</div>

<style>
	.name-row {
		display: flex;
		align-items: flex-start;
		gap: var(--sp-2);
		padding: var(--sp-1) var(--sp-3);
		min-height: var(--row-h);
		> :global(.icon) {
			margin-top: var(--sp-2);
			color: var(--fg-muted);
		}
	}
	.field {
		flex: 1;
		min-width: 0;
		input {
			width: 100%;
			padding-block: var(--sp-1);
			min-height: 0;
		}
	}
</style>
