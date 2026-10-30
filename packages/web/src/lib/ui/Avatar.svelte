<script lang="ts">
	interface Props {
		name: string;
		src?: string | null;
		/** sm 20px · md 24px · lg 40px */
		size?: "sm" | "md" | "lg";
	}

	let { name, src = null, size = "md" }: Props = $props();

	let failed = $state(false);
	const initials = $derived(
		name
			.split(/[\s@._-]+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? "")
			.join("") || "?",
	);
</script>

<span class="avatar" data-size={size} aria-hidden="true">
	{#if src && !failed}
		<img {src} alt="" referrerpolicy="no-referrer" onerror={() => (failed = true)} />
	{:else}
		{initials}
	{/if}
</span>

<style>
	.avatar {
		--size: var(--avatar-md);
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--size);
		height: var(--size);
		border-radius: var(--radius-full);
		overflow: hidden;
		background: var(--accent-soft);
		color: var(--accent);
		font-size: calc(var(--size) * 0.42);
		font-weight: 600;
		line-height: 1;
		&[data-size="sm"] {
			--size: var(--avatar-sm);
		}
		&[data-size="lg"] {
			--size: var(--avatar-lg);
		}
	}
	img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
</style>
