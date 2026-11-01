<script lang="ts">
	import { api, errorMessage } from "../../lib/api";
	import { AgentSession } from "../../lib/agent/session.svelte";
	import type { Effect, SendKind, UiAnswer } from "../../lib/agent/types";
	import { tildify } from "../../lib/format";
	import { Icons } from "../../lib/icons";
	import type { PaneContext } from "../../lib/shell/pane.svelte";
	import { session as me } from "../../lib/shell/session.svelte";
	import { shell } from "../../lib/shell/shell.svelte";
	import type { WindowOf } from "../../lib/shell/types";
	import { viewport } from "../../lib/shell/viewport.svelte";
	import AsyncButton from "../../lib/ui/AsyncButton.svelte";
	import Banner from "../../lib/ui/Banner.svelte";
	import Button from "../../lib/ui/Button.svelte";
	import EmptyState from "../../lib/ui/EmptyState.svelte";
	import Skeleton from "../../lib/ui/Skeleton.svelte";
	import { toast } from "../../lib/ui/toast.svelte";
	import Composer from "./Composer.svelte";
	import MessageList from "./MessageList.svelte";
	import QuestionCard from "./QuestionCard.svelte";

	let { win, pane }: { win: WindowOf<"agent">; pane: PaneContext<"agent"> } = $props();

	const agentId = $derived(win.props.agentId);
	const cwd = $derived(win.props.cwd);

	let agent = $state<AgentSession | null>(null);
	let composer = $state<ReturnType<typeof Composer> | null>(null);
	let createError = $state<string | null>(null);
	let creating = false;

	const view = $derived(agent?.view ?? null);
	const conn = $derived(agent?.conn ?? "connecting");
	const live = $derived(conn === "live" && view?.loaded === true);
	/** The gateway no longer knows this agent id (closed 4404/4410 or missing from /api/agents). */
	const gone = $derived(conn === "exited");

	function onEffect(effect: Effect) {
		switch (effect.type) {
			case "toast":
				toast({ message: effect.message, tone: effect.tone });
				break;
			case "restore":
				composer?.restore(effect.text);
				break;
			case "editor":
				composer?.setText(effect.text);
				break;
			case "open-url":
				toast({
					message: effect.instructions ?? "The agent wants to open a link.",
					action: { label: "Open", run: () => window.open(effect.url, "_blank", "noopener,noreferrer") },
				});
				break;
		}
	}

	async function createSession(): Promise<void> {
		const info = await api.agents.create({ cwd });
		pane.setProps({ agentId: info.id });
	}

	/** A window opened without a session (launcher "New agent") creates one. */
	async function autoStart(): Promise<void> {
		if (creating) return;
		creating = true;
		createError = null;
		try {
			await createSession();
		} catch (err) {
			createError = errorMessage(err);
		} finally {
			creating = false;
		}
	}

	async function restart(): Promise<void> {
		try {
			await createSession();
		} catch (err) {
			toast({ message: errorMessage(err), tone: "danger" });
		}
	}

	/** Most start failures are a missing provider or model: OMP's setup wizard, in a terminal, fixes those. */
	function setUpOmp(): void {
		shell.open({ kind: "terminal", title: "OMP setup", props: { cwd, command: ["omp", "setup"] } }, { keyboard: true });
	}

	$effect(() => {
		if (!agentId && !createError) void autoStart();
	});

	$effect(() => {
		if (!agentId) return;
		const s = new AgentSession(agentId, onEffect);
		agent = s;
		return () => {
			s.dispose();
			agent = null;
		};
	});

	$effect(() => {
		const status = pane.status;
		status.conn = agentId ? (view?.exited ? "exited" : conn) : createError ? null : "connecting";
		status.exitCode = view?.exited ? view.exitCode : null;
		status.clients = view?.info?.clients ?? 0;
		status.busy = view?.busy ?? false;
		status.needsInput = (view?.pendingUi.length ?? 0) > 0;
		status.title = view?.info?.title ?? null;
		status.subtitle = tildify(cwd, me.me?.home);
	});

	$effect(() => pane.onFocusRequest(() => composer?.focus()));

	const empty = $derived(
		view !== null && view.loaded && view.items.length === 0 && view.outbox.length === 0 && !view.busy,
	);

	// A fresh session starts with the composer focused (not on touch, where focusing pops the keyboard).
	$effect(() => {
		if (empty && pane.focused && !viewport.coarse) composer?.focus();
	});

	function send(kind: SendKind, text: string): boolean {
		return agent?.send(kind, text) ?? false;
	}

	function answer(id: string, value: UiAnswer) {
		if (!agent?.answer(id, value)) toast({ message: "You're offline. Answer again once the connection is back.", tone: "danger" });
	}
</script>

<div class="agent">
	{#if gone}
		<Banner tone="neutral" icon={Icons.Warn} text="This agent session no longer exists.">
			{#snippet actions()}
				<AsyncButton size="sm" variant="secondary" action={restart} pendingLabel="Starting…">Start new session</AsyncButton>
			{/snippet}
		</Banner>
	{:else if view?.exited}
		<Banner
			tone={view.exitCode ? "danger" : "neutral"}
			text="Agent session ended{view.exitCode !== null ? ` (code ${view.exitCode})` : ''}. Sending a message resumes it."
		>
			{#snippet actions()}
				<AsyncButton size="sm" variant="secondary" action={restart} pendingLabel="Starting…">Start new session</AsyncButton>
			{/snippet}
		</Banner>
	{:else if conn === "reconnecting"}
		<Banner tone="warning" icon={Icons.Offline} text="Reconnecting… The agent keeps working on the server.">
			{#snippet actions()}
				<Button size="sm" variant="secondary" onclick={() => agent?.retryNow()}>Retry now</Button>
			{/snippet}
		</Banner>
	{:else if conn === "offline"}
		<Banner tone="neutral" icon={Icons.Offline} text="You're offline. The agent keeps working on {me.me?.host ?? 'the server'} and reconnects when you're back." />
	{/if}

	{#if !agentId && createError}
		<div class="center">
			<EmptyState icon={Icons.Agent} title="Couldn't start an agent" text={createError}>
				{#snippet actions()}
					<AsyncButton action={autoStart} pendingLabel="Starting…">Retry</AsyncButton>
				{/snippet}
			</EmptyState>
		</div>
	{:else if conn === "failed"}
		<div class="center">
			<EmptyState icon={Icons.Agent} title="The agent couldn't start" text={view?.startError ?? "OMP exited before it was ready."}>
				{#snippet actions()}
					<Button variant="secondary" icon={Icons.Terminal} onclick={setUpOmp}>Set up OMP</Button>
					<Button onclick={() => agent?.retryNow()}>Retry</Button>
				{/snippet}
			</EmptyState>
		</div>
	{:else if !view?.loaded}
		<div class="loading" aria-busy="true">
			<Skeleton preset="blocks" note={conn === "connecting" ? null : "Waiting for the agent…"} />
		</div>
	{:else if empty}
		<div class="center">
			<EmptyState
				icon={Icons.Agent}
				title="Start a session"
				text="Ask the agent to change something in {tildify(cwd, me.me?.home)}."
			/>
		</div>
	{:else}
		<MessageList {view} reducedMotion={viewport.reducedMotion} />
	{/if}

	{#if view && (view.pendingUi.length > 0 || Object.keys(view.statuses).length > 0 || Object.keys(view.widgets).length > 0)}
		<div class="extras">
			{#each Object.values(view.widgets).filter(w => w.placement === "aboveEditor") as widget, i (i)}
				<pre class="widget">{widget.lines.join("\n")}</pre>
			{/each}
			{#each view.pendingUi as req (req.id)}
				<QuestionCard {req} {live} onanswer={value => answer(req.id, value)} onexpire={() => agent?.expire(req.id)} />
			{/each}
			{#if Object.keys(view.statuses).length > 0}
				<p class="statuses meta">
					{#each Object.entries(view.statuses) as [key, text] (key)}<span class="truncate">{text}</span>{/each}
				</p>
			{/if}
		</div>
	{/if}

	<Composer
		bind:this={composer}
		windowId={win.id}
		busy={view?.busy ?? false}
		{live}
		stopping={agent?.stopping ?? false}
		coarse={viewport.coarse}
		onsend={send}
		onstop={() => void agent?.abort()}
	/>

	{#if view && Object.values(view.widgets).some(w => w.placement === "belowEditor")}
		<div class="below">
			{#each Object.values(view.widgets).filter(w => w.placement === "belowEditor") as widget, i (i)}
				<pre class="widget">{widget.lines.join("\n")}</pre>
			{/each}
		</div>
	{/if}
</div>

<style>
	.agent {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--surface-1);
	}
	.center {
		flex: 1;
		min-height: 0;
		display: grid;
		place-items: center;
		padding: var(--sp-4);
		overflow-y: auto;
	}
	.loading {
		flex: 1;
		min-height: 0;
		width: 100%;
		max-width: var(--chat-measure);
		margin-inline: auto;
		padding: var(--sp-4);
	}
	.extras,
	.below {
		display: grid;
		gap: var(--sp-2);
		width: 100%;
		max-width: var(--chat-measure);
		margin-inline: auto;
		padding: var(--sp-2) var(--sp-3);
		flex: none;
		max-height: 60%;
		overflow-y: auto;
	}
	.below {
		background: var(--surface-2);
	}
	.statuses {
		display: flex;
		flex-wrap: wrap;
		gap: var(--sp-1) var(--sp-3);
		min-width: 0;
	}
	.widget {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--fg-muted);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
