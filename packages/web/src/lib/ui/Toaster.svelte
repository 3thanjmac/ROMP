<script lang="ts">
	import { Icons } from "../icons";
	import { viewport } from "../shell/viewport.svelte";
	import Button from "./Button.svelte";
	import { raiseTop } from "./floating";
	import IconButton from "./IconButton.svelte";
	import { closeToast, pauseToast, resumeToast, runToastAction, toasts } from "./toast.svelte";

	let el: HTMLDivElement;
	let lastShown = 0;

	// The region lives in the top layer so toasts stay visible above open dialogs and sheets; a newer toast
	// re-raises it above anything opened since.
	$effect(() => {
		const newest = toasts.at(-1)?.id ?? 0;
		if (newest === 0) {
			if (el.matches(":popover-open")) el.hidePopover();
		} else if (newest !== lastShown) {
			raiseTop(el);
		}
		lastShown = newest;
	});
</script>

<div class="toaster" popover="manual" role="region" aria-label="Notifications" data-layout={viewport.layout} bind:this={el}>
	{#each toasts as t (t.id)}
		<div
			class="toast"
			data-tone={t.tone}
			role={t.tone === "danger" ? "alert" : "status"}
			onpointerenter={() => pauseToast(t.id)}
			onpointerleave={() => resumeToast(t.id)}
			onfocusin={() => pauseToast(t.id)}
			onfocusout={() => resumeToast(t.id)}
		>
			<p class="message">{t.message}</p>
			{#if t.action}
				<Button size="sm" variant="ghost" onclick={() => runToastAction(t.id)}>{t.action.label}</Button>
			{/if}
			<IconButton size="sm" iconSize="sm" label="Dismiss" icon={Icons.Close} onclick={() => closeToast(t.id)} />
		</div>
	{/each}
</div>

<style>
	.toaster {
		position: fixed;
		inset: auto var(--sp-4) calc(var(--sp-4) + var(--safe-bottom)) auto;
		width: var(--toast-w);
		max-width: calc(100vw - 2 * var(--sp-4));
		margin: 0;
		padding: 0;
		border: 0;
		background: none;
		overflow: visible;
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		&:not(:popover-open) {
			display: none;
		}
		&[data-layout="phone"] {
			inset: auto var(--sp-2)
				calc(max(var(--kb-inset), var(--bottombar-h) + var(--safe-bottom)) + var(--sp-2)) var(--sp-2);
			width: auto;
			max-width: none;
		}
	}
	.toast {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-3);
		color: var(--fg);
		background: var(--surface-3);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
		transition:
			opacity var(--dur-enter) var(--ease),
			translate var(--dur-enter) var(--ease);
		&[data-tone="danger"] {
			border-inline-start: var(--edge-w) solid var(--danger);
		}
		&[data-tone="success"] {
			border-inline-start: var(--edge-w) solid var(--success);
		}
	}
	@starting-style {
		.toast {
			opacity: 0;
			translate: 0 var(--sp-2);
		}
	}
	.message {
		flex: 1;
		min-width: 0;
		padding-block: var(--sp-1);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
</style>
