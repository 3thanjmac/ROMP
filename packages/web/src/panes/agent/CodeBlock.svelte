<script lang="ts">
	import { Icons } from "../../lib/icons";
	import IconButton from "../../lib/ui/IconButton.svelte";
	import { toast } from "../../lib/ui/toast.svelte";

	let { text, lang }: { text: string; lang: string } = $props();

	let copied = $state(false);
	let timer: number | undefined;

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			toast({ message: "Couldn't copy. Select the code and copy it manually.", tone: "danger" });
			return;
		}
		copied = true;
		clearTimeout(timer);
		timer = window.setTimeout(() => (copied = false), 1500);
	}

	$effect(() => () => clearTimeout(timer));
</script>

<div class="code" data-lang={lang || undefined}>
	<pre><code>{text}</code></pre>
	<div class="copy">
		<IconButton label={copied ? "Copied" : "Copy code"} icon={copied ? Icons.Check : Icons.Copy} size="sm" iconSize="sm" onclick={copy} />
	</div>
</div>

<style>
	.code {
		position: relative;
		background: var(--inset);
		border-radius: var(--radius-md);
	}
	pre {
		margin: 0;
		padding: var(--sp-3);
		overflow-x: auto;
		font-size: var(--text-sm);
		line-height: 1.5;
	}
	.copy {
		position: absolute;
		top: var(--sp-1);
		right: var(--sp-1);
		opacity: 0;
		background: var(--inset);
		border-radius: var(--radius-md);
		transition: opacity var(--dur-fast);
	}
	.code:hover .copy,
	.code:focus-within .copy {
		opacity: 1;
	}
	@media (pointer: coarse) {
		.copy {
			opacity: 1;
		}
	}
</style>
