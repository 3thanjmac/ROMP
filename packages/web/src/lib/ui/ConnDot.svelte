<script lang="ts">
	import type { ConnState } from "../conn/socket.svelte";
	import { tooltip } from "./tooltip";

	let { state, exitCode = null }: { state: ConnState; exitCode?: number | null } = $props();

	const label = $derived(
		state === "live"
			? "Live"
			: state === "connecting"
				? "Connecting…"
				: state === "reconnecting"
					? "Reconnecting…"
					: state === "offline"
						? "Offline"
						: state === "failed"
							? "Couldn't start"
							: exitCode === null
								? "Exited"
								: `Exited (code ${exitCode})`,
	);
</script>

<span
	class="dot"
	data-state={state}
	data-failed={state === "failed" || (state === "exited" && exitCode !== null && exitCode !== 0) ? "" : undefined}
	role="img"
	aria-label={label}
	use:tooltip
></span>

<style>
	.dot {
		display: inline-block;
		flex: none;
		width: var(--dot-md);
		height: var(--dot-md);
		border-radius: var(--radius-full);
		background: var(--conn-live);
		&[data-state="connecting"] {
			background: var(--conn-connecting);
		}
		&[data-state="reconnecting"] {
			background: var(--conn-reconnecting);
		}
		&[data-state="offline"] {
			background: none;
			box-shadow: inset 0 0 0 var(--ring-w) var(--conn-offline);
		}
		&[data-state="exited"] {
			background: var(--conn-exited);
		}
		&[data-failed] {
			background: var(--danger);
		}
	}
	@media (prefers-reduced-motion: no-preference) {
		.dot[data-state="connecting"],
		.dot[data-state="reconnecting"] {
			animation: pulse var(--dur-pulse) ease-in-out infinite;
		}
	}
</style>
