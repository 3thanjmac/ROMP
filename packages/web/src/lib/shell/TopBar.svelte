<script lang="ts">
	import { net } from "../conn/net.svelte";
	import { Icons } from "../icons";
	import Avatar from "../ui/Avatar.svelte";
	import Button from "../ui/Button.svelte";
	import Chip from "../ui/Chip.svelte";
	import Segmented from "../ui/Segmented.svelte";
	import { tooltip } from "../ui/tooltip";
	import { session } from "./session.svelte";
	import { shell } from "./shell.svelte";
	import StripMap from "./StripMap.svelte";
	import { frameUi } from "./ui.svelte";
	import WorkspaceTabs from "./WorkspaceTabs.svelte";

	const modes = [
		{ value: "scroll" as const, label: "Scroll", icon: Icons.ModeScroll },
		{ value: "tile" as const, label: "Tile", icon: Icons.ModeTile },
	];
</script>

<header class="topbar">
	<div class="left"><WorkspaceTabs /></div>
	<div class="center">
		{#if shell.active.mode === "scroll"}<StripMap />{/if}
	</div>
	<div class="right">
		{#if net.offline}
			<Chip tone="warning" icon={Icons.Offline}>Offline</Chip>
		{/if}
		<Segmented
			label="Layout mode"
			options={modes}
			value={shell.active.mode}
			onchange={(mode) => shell.setMode(mode)}
		/>
		<Button size="sm" icon={Icons.Add} onclick={() => (frameUi.palette = true)}>
			New window <kbd>Alt O</kbd>
		</Button>
		{#if session.me}
			{@const me = session.me}
			<span class="me" role="img" aria-label="{me.displayName} · {me.user}@{me.host}" use:tooltip>
				<Avatar name={me.displayName} src={me.avatarUrl} />
			</span>
		{/if}
	</div>
</header>

<style>
	.topbar {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		align-items: center;
		gap: var(--sp-3);
		height: calc(var(--topbar-h) + var(--safe-top));
		padding: var(--safe-top) calc(var(--sp-2) + var(--safe-right)) 0 calc(var(--sp-2) + var(--safe-left));
		background: var(--surface-2);
		border-block-end: var(--border);
		z-index: var(--z-bar);
		flex: none;
	}
	.left,
	.center,
	.right {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-width: 0;
	}
	.center {
		justify-content: center;
	}
	.right {
		justify-content: flex-end;
	}
	.me {
		display: inline-flex;
	}
</style>
