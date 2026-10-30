<script module lang="ts">
	/** xs 12px · sm 14px · md 16px (chrome, rows) · lg 20px (bottom bar, tiles) · xl 24px (empty states) */
	export type IconSize = "xs" | "sm" | "md" | "lg" | "xl";
</script>

<script lang="ts">
	import type { IconComponent } from "../icons";

	interface Props {
		icon: IconComponent;
		size?: IconSize;
		/** Rotates continuously (static under prefers-reduced-motion). */
		spin?: boolean;
		/** Accessible name; omit for decorative icons. */
		label?: string;
	}

	let { icon: Glyph, size = "md", spin = false, label }: Props = $props();
</script>

<Glyph
	class="icon"
	data-size={size}
	data-spin={spin || undefined}
	aria-hidden={label ? undefined : "true"}
	aria-label={label}
	role={label ? "img" : undefined}
/>
