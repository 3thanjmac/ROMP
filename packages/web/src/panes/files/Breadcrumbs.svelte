<script lang="ts">
	import { Icons } from "../../lib/icons";
	import Icon from "../../lib/ui/Icon.svelte";

	interface Props {
		path: string;
		/** Shown as "~" when the path is inside it. */
		home: string | null;
		onnavigate: (path: string) => void;
	}

	let { path, home, onnavigate }: Props = $props();

	const crumbs = $derived.by(() => {
		const out: Array<{ label: string; path: string }> = [];
		let rest = path;
		let base = "";
		if (home && (path === home || path.startsWith(`${home}/`))) {
			out.push({ label: "~", path: home });
			base = home;
			rest = path.slice(home.length);
		} else {
			out.push({ label: "/", path: "/" });
		}
		for (const part of rest.split("/").filter(Boolean)) {
			base = `${base}/${part}`;
			out.push({ label: part, path: base });
		}
		return out;
	});

	let el: HTMLElement;
	$effect(() => {
		void crumbs;
		el.scrollLeft = el.scrollWidth;
	});
</script>

<nav class="crumbs" aria-label="Path" bind:this={el}>
	{#each crumbs as c, i (c.path)}
		{#if i > 0}<Icon icon={Icons.ChevronRight} size="xs" />{/if}
		{#if i === crumbs.length - 1}
			<span class="crumb current truncate" aria-current="location">{c.label}</span>
		{:else}
			<button class="crumb truncate" onclick={() => onnavigate(c.path)}>{c.label}</button>
		{/if}
	{/each}
</nav>

<style>
	.crumbs {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
		color: var(--fg-subtle);
	}
	.crumb {
		flex: none;
		max-width: var(--crumb-max);
		padding: var(--sp-1) var(--sp-1);
		border-radius: var(--radius-sm);
		font-size: var(--text-sm);
		color: var(--fg-muted);
	}
	button.crumb:hover {
		background: var(--surface-3);
		color: var(--fg);
	}
	.current {
		color: var(--fg);
		font-weight: 500;
	}
</style>
