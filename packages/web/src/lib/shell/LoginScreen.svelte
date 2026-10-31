<script lang="ts">
	import { tick } from "svelte";
	import { ApiFailure, api } from "../api";
	import AsyncButton from "../ui/AsyncButton.svelte";

	let password = $state("");
	let pending = $state(false);
	let error: string | null = $state(null);
	let passwordInput: HTMLInputElement | undefined = $state();
	const host = location.host;

	function failureMessage(err: unknown): string {
		if (!(err instanceof ApiFailure)) return "Sign-in failed. Try again.";
		switch (err.code) {
			case "bad_password":
				return "Incorrect password. Try again.";
			case "rate_limited":
				return err.message || "Too many attempts. Try again shortly.";
			case "forbidden":
				return "Sign-in isn't enabled on this gateway. Contact the gateway owner.";
			case "unreachable":
				return "Couldn't reach the gateway. Check your connection and try again.";
			default:
				return "Sign-in failed. Try again.";
		}
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (pending) return;
		error = null;
		pending = true;
		try {
			await api.login({ password });
		} catch (err) {
			error = failureMessage(err);
			pending = false;
			await tick();
			passwordInput?.focus();
			if (err instanceof ApiFailure && err.code === "bad_password") passwordInput?.select();
			return;
		}
		window.location.reload();
	}
</script>

<main class="screen" aria-labelledby="login-title">
	<div class="panel">
		<h1 id="login-title">Sign In to ROMP</h1>
		<p id="login-help" class="muted">
			Enter the password for <span class="mono host">{host}</span> to continue.
		</p>
		<form onsubmit={submit}>
			<div class="field">
				<label for="login-password">Password</label>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					bind:this={passwordInput}
					bind:value={password}
					id="login-password"
					name="password"
					type="password"
					required
					autofocus
					autocomplete="current-password"
					autocapitalize="none"
					autocorrect="off"
					spellcheck="false"
					enterkeyhint="go"
					disabled={pending}
					aria-invalid={error ? "true" : undefined}
					aria-describedby={error ? "login-help login-error" : "login-help"}
					oninput={() => (error = null)}
				/>
				{#if error}
					<p id="login-error" class="field-error" role="alert" aria-live="assertive">{error}</p>
				{/if}
			</div>
			<div class="actions">
				<AsyncButton type="submit" variant="primary" bind:pending pendingLabel="Signing in…">Sign in</AsyncButton>
			</div>
		</form>
	</div>
</main>

<style>
	.screen {
		position: fixed;
		top: var(--vv-top);
		left: 0;
		right: 0;
		height: var(--vvh);
		display: flex;
		overflow-y: auto;
		padding: calc(var(--safe-top) + var(--sp-6)) calc(var(--safe-right) + var(--sp-4))
			calc(var(--safe-bottom) + var(--sp-6)) calc(var(--safe-left) + var(--sp-4));
	}
	.panel {
		flex: none;
		width: min(100%, var(--dialog-w));
		margin: auto;
		padding: var(--sp-6);
		background: var(--surface-1);
		border: var(--border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
		> h1 + p {
			margin-top: var(--sp-2);
		}
	}
	.host {
		overflow-wrap: anywhere;
	}
	form {
		display: grid;
		gap: var(--sp-4);
		margin-top: var(--sp-6);
	}
	.field {
		display: grid;
		> label {
			margin-bottom: var(--sp-1);
		}
	}
	.actions {
		display: grid;
	}
</style>
