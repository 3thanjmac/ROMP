<script lang="ts">
	import SignInForm, { SIGN_IN_TEXT, type SignInPhase } from "../../panes/terminal/SignInForm.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import { frameUi } from "./ui.svelte";

	let phase: SignInPhase = $state("idle");

	$effect(() => {
		if (frameUi.signInDialog) phase = "idle";
	});
</script>

<!-- "Finish sign-in…" from the palette when no terminal is focused; terminals show the same form as a banner. -->
<Dialog bind:open={frameUi.signInDialog} title="Finish sign-in">
	<p class="muted" role="status">{SIGN_IN_TEXT[phase]}</p>
	<SignInForm port={null} bind:phase onclose={() => (frameUi.signInDialog = false)} />
</Dialog>
