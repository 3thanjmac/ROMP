<script lang="ts">
	/** "Running sessions": live terminals and agents that no window shows. Hidden while empty. */
	import { errorMessage } from "../api";
	import { KIND_ICON } from "../icons";
	import ClientCount from "../ui/ClientCount.svelte";
	import Icon from "../ui/Icon.svelte";
	import Spinner from "../ui/Spinner.svelte";
	import { attach, type RunningSession, runningSessions } from "./launcherItems";
	import { session } from "./session.svelte";
	import { tildify } from "../format";

	let { onpick }: { onpick: () => void } = $props();

	let items: RunningSession[] = $state([]);
	let error: string | null = $state(null);

	$effect(() => {
		let live = true;
		runningSessions().then(
			(list) => live && (items = list),
			(err) => live && (error = errorMessage(err)),
		);
		return () => {
			live = false;
		};
	});
</script>

{#if items.length > 0}
	<section>
		<h4>Running sessions</h4>
		<ul>
			{#each items as s (s.info.id)}
				<li>
					<button class="row" onclick={() => (attach(s), onpick())}>
						<Icon icon={KIND_ICON[s.kind]} />
						<span class="text">
							<span class="truncate">{s.info.title || (s.kind === "terminal" ? "Terminal" : "Agent")}</span>
							<span class="meta mono truncate">{tildify(s.info.cwd, session.me?.home)}</span>
						</span>
						{#if s.kind === "agent" && s.info.busy}<span class="meta busy"><Spinner size="sm" />Working</span>{/if}
						<ClientCount count={s.info.clients} />
					</button>
				</li>
			{/each}
		</ul>
	</section>
{:else if error}
	<p class="meta">Couldn't list running sessions: {error}</p>
{/if}

<style>
	section {
		display: grid;
		gap: var(--sp-1);
	}
	h4 {
		color: var(--fg-muted);
		padding: var(--sp-2) 0 var(--sp-1);
	}
	ul {
		list-style: none;
		padding: 0;
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		width: 100%;
		min-height: var(--row-h);
		padding: var(--sp-1) var(--sp-2);
		border-radius: var(--radius-md);
		color: var(--fg);
		&:hover,
		&:active {
			background: var(--surface-3);
		}
		> :global(.icon) {
			color: var(--fg-muted);
		}
	}
	.text {
		display: grid;
		flex: 1;
		min-width: 0;
	}
	.busy {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
	}
</style>
