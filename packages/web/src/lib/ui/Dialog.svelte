<script lang="ts">
	import type { Snippet } from "svelte";

	interface Props {
		open: boolean;
		/** Visible h2 title; omit for chrome-less dialogs (then pass `label`). */
		title?: string;
		label?: string;
		/** dialog: centered, --dialog-w · palette: top-anchored at --palette-top, --palette-w */
		variant?: "dialog" | "palette";
		children: Snippet;
		/** Actions, right-aligned: secondary first, primary last. */
		footer?: Snippet;
		onclose?: () => void;
	}

	let { open = $bindable(false), title, label, variant = "dialog", children, footer, onclose }: Props = $props();

	const headingId = $props.id();
	let el: HTMLDialogElement;
	let pressedBackdrop = false;

	$effect(() => {
		if (open && !el.open) el.showModal();
		else if (!open && el.open) el.close();
	});

	function closed() {
		open = false;
		onclose?.();
	}
</script>

<dialog
	bind:this={el}
	class={variant}
	aria-label={title ? undefined : label}
	aria-labelledby={title ? headingId : undefined}
	onclose={closed}
	onpointerdown={(e) => (pressedBackdrop = e.target === el)}
	onclick={(e) => {
		if (pressedBackdrop && e.target === el) el.close();
		pressedBackdrop = false;
	}}
>
	{#if open}
		<div class="inner">
			{#if title}<h2 id={headingId}>{title}</h2>{/if}
			{@render children()}
			{#if footer}<footer>{@render footer()}</footer>{/if}
		</div>
	{/if}
</dialog>

<style>
	dialog {
		/* The global `* { margin: 0 }` reset removes the UA's centering margin. */
		margin: auto;
		width: min(var(--dialog-w), 100vw - 2 * var(--sp-4));
		max-width: none;
		max-height: calc(var(--vvh) - 2 * var(--sp-4));
		padding: 0;
		color: var(--fg);
		background: var(--surface-2);
		border: var(--border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		overflow: auto;
		&::backdrop {
			background: var(--overlay);
		}
		&.palette {
			width: min(var(--palette-w), 100vw - 2 * var(--sp-4));
			margin-top: var(--palette-top);
			margin-bottom: auto;
			max-height: var(--palette-max-h);
			overflow: hidden;
			.inner {
				padding: 0;
				gap: 0;
				max-height: var(--palette-max-h);
			}
		}
	}
	.inner {
		display: grid;
		gap: var(--sp-3);
		padding: var(--sp-4);
		align-content: start;
	}
	footer {
		display: flex;
		justify-content: flex-end;
		flex-wrap: wrap;
		gap: var(--sp-2);
		margin-top: var(--sp-1);
	}
</style>
