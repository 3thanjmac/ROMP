<script module lang="ts">
	export type SignInPhase = "idle" | "failed" | "done";

	/** Banner copy for each phase. */
	export const SIGN_IN_TEXT: Record<SignInPhase, string> = {
		idle: "Finishing a sign-in? After approving, copy the address your browser ended on and paste it here.",
		failed: "Couldn't finish the sign-in.",
		done: "Sign-in finished. You can go back to the terminal.",
	};
</script>

<script lang="ts">
	import { parseLoopbackCallback } from "@romp/protocol";
	import { onDestroy } from "svelte";
	import { api, errorMessage } from "../../lib/api";
	import AsyncButton from "../../lib/ui/AsyncButton.svelte";
	import Button from "../../lib/ui/Button.svelte";

	interface Props {
		/** Port the detected sign-in waits on; null accepts any loopback port. */
		port: number | null;
		phase?: SignInPhase;
		input?: HTMLInputElement;
		/** Dismissed, or shown success long enough. */
		onclose: () => void;
		/** Focus was inside the form when it went away: give it back to whatever the form belongs to. */
		onreturnfocus?: () => void;
	}

	let { port, phase = $bindable("idle"), input = $bindable(), onclose, onreturnfocus }: Props = $props();

	const DONE_MS = 4000;
	const id = $props.id();

	let root: HTMLElement | undefined = $state();
	/** The callback address holds a one-time code: it lives only here, never in workspace state. */
	let draft = $state("");
	let fieldError: string | null = $state(null);
	let failure: string | null = $state(null);
	let busy = $state(false);
	let doneTimer: number | undefined;

	onDestroy(() => clearTimeout(doneTimer));

	const focusInside = () => !!root?.contains(document.activeElement);

	function validate(text: string): string | null {
		if (!text) return "Paste the callback address first.";
		const target = parseLoopbackCallback(text);
		if (!target) return "That isn't a localhost address. Copy the full address your browser ended on.";
		if (port !== null && target.port !== port) {
			return `That address goes to port ${target.port}, but this sign-in is waiting on port ${port}.`;
		}
		return null;
	}

	async function submit() {
		if (busy) return;
		const text = draft.trim();
		fieldError = validate(text);
		if (fieldError) return;
		busy = true;
		try {
			const result = await api.callback.deliver(text);
			if (result.status >= 400) {
				failure = `The sign-in page answered ${result.status}${result.message ? `: ${result.message}` : "."}`;
				phase = "failed";
				return;
			}
			const hadFocus = focusInside();
			failure = null;
			draft = "";
			phase = "done";
			if (hadFocus) onreturnfocus?.();
			doneTimer = window.setTimeout(onclose, DONE_MS);
		} catch (err) {
			failure = errorMessage(err);
			phase = "failed";
		} finally {
			busy = false;
		}
	}

	async function pasteAndSubmit() {
		if (busy) return;
		let text: string;
		try {
			// First thing in the tap, which iOS requires; it then shows its own Paste confirmation.
			text = (await navigator.clipboard.readText()).trim();
		} catch {
			fieldError = "Couldn't read the clipboard. Paste the address into the field instead.";
			input?.focus({ preventScroll: true });
			return;
		}
		if (!text) {
			fieldError = "Clipboard is empty. Paste the address into the field instead.";
			input?.focus({ preventScroll: true });
			return;
		}
		draft = text;
		await submit();
	}

	function dismiss() {
		if (focusInside()) onreturnfocus?.();
		onclose();
	}
</script>

{#if phase !== "done"}
	<form
		bind:this={root}
		class="signin"
		novalidate
		onsubmit={(e) => {
			e.preventDefault();
			void submit();
		}}
	>
		<label class="sr-only" for="{id}-url">Callback address</label>
		<input
			bind:this={input}
			bind:value={draft}
			id="{id}-url"
			class="mono"
			type="url"
			inputmode="url"
			placeholder="http://localhost:…/callback?code=…"
			autocapitalize="off"
			autocomplete="off"
			spellcheck="false"
			enterkeyhint="go"
			aria-invalid={fieldError ? "true" : undefined}
			aria-describedby={fieldError || failure ? `${id}-error` : undefined}
		/>
		{#if fieldError}
			<p id="{id}-error" class="field-error" role="alert">{fieldError}</p>
		{:else if failure}
			<p id="{id}-error" class="field-error">{failure}</p>
			<p class="meta">Check the address, then try again.</p>
		{/if}
		<div class="actions">
			<AsyncButton type="submit" size="sm" variant="primary" pending={busy} pendingLabel="Finishing…">
				{failure ? "Retry" : "Finish sign-in"}
			</AsyncButton>
			<AsyncButton size="sm" variant="secondary" pending={busy} pendingLabel="Finishing…" onclick={pasteAndSubmit}>
				Paste from clipboard
			</AsyncButton>
			<Button size="sm" variant="ghost" onclick={dismiss}>Dismiss</Button>
		</div>
	</form>
{/if}

<style>
	.signin {
		display: grid;
		gap: var(--sp-1);
		input {
			width: 100%;
			min-width: 0;
		}
		p {
			margin: 0;
		}
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-2);
		margin-top: var(--sp-1);
	}
</style>
