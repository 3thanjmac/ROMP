<script lang="ts">
	import type { AgentUsage, UsageLimit } from "@romp/protocol";
	import { tick, untrack } from "svelte";
	import { api, errorMessage } from "../api";
	import { approxPercent, formatUsd, resetsIn, windowName } from "../format";
	import { Icons } from "../icons";
	import AsyncButton from "../ui/AsyncButton.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import Popover from "../ui/Popover.svelte";
	import Spinner from "../ui/Spinner.svelte";

	let { agentId }: { agentId: string | null } = $props();

	let open = $state(false);
	let anchor = $state<HTMLElement | null>(null);
	let panel = $state<HTMLElement | null>(null);

	let usage = $state<AgentUsage | null>(null);
	let loadError = $state<string | null>(null);
	let loading = $state(false);
	/** The in-flight request; concurrent opens and retries share it. */
	let pending: Promise<void> | null = null;
	/** Bumped when the agent changes so a late response for the previous one is dropped. */
	let generation = 0;

	$effect.pre(() => {
		const id = agentId;
		untrack(() => {
			generation++;
			pending = null;
			loading = false;
			usage = null;
			loadError = null;
			if (!id) open = false;
			else if (open) void load();
		});
	});

	function load(): Promise<void> {
		if (pending) return pending;
		const id = agentId;
		if (!id) return Promise.resolve();
		const gen = generation;
		loading = true;
		const req: Promise<void> = api.agents.usage(id).then(
			(u) => {
				if (gen !== generation) return;
				usage = u;
				loadError = null;
			},
			(err: unknown) => {
				if (gen === generation) loadError = errorMessage(err);
			},
		);
		pending = req;
		void req.finally(() => {
			if (pending !== req) return;
			pending = null;
			loading = false;
		});
		return req;
	}

	async function show() {
		open = true;
		void load();
		await tick();
		panel?.focus({ preventScroll: true });
	}

	function hide(returnFocus: boolean) {
		if (!open) return;
		open = false;
		if (returnFocus) anchor?.focus({ preventScroll: true });
	}

	function ref(node: HTMLElement) {
		anchor = node;
		return () => {
			if (anchor === node) anchor = null;
		};
	}

	const model = $derived(usage?.model ?? null);
	/** Reports for the chat's provider when OMP returned any, else every provider. */
	const providers = $derived.by(() => {
		const all = usage?.limits ?? [];
		const mine = model ? all.filter((p) => p.provider === model.provider) : [];
		return mine.length > 0 ? mine : all;
	});
	const limits = $derived(providers.flatMap((p) => p.limits));
	const fetchedAt = $derived(providers.length > 0 ? Math.max(...providers.map((p) => p.fetchedAt)) : null);
	const stats = $derived(usage?.chat.stats ?? null);
	/** Time windows only: a share of a spend cap (Extra Usage) reads as nonsense next to "5-hour" and "7-day". */
	const shareRows = $derived(
		limits.flatMap((limit) => {
			const share = usage?.chat.shares[limit.id];
			return share === undefined || limit.resetsAt === null || limit.windowLabel === null ? [] : [{ limit, share }];
		}),
	);
	/** Nothing attributed yet (a fresh chat, or no turn has ended since the gateway started sampling). */
	const noShares = $derived(!shareRows.some((r) => r.share > 0));

	const percent = (fraction: number) => Math.round(fraction * 100);
	const clamp = (fraction: number) => Math.max(0, Math.min(1, fraction));
	const count = (n: number) => n.toLocaleString();

	function limitValue(l: UsageLimit): string {
		if (l.unit === "percent" && l.usedFraction !== null) return `${percent(l.usedFraction)}% used`;
		if (l.used !== null) {
			if (l.unit === "usd") return l.limit !== null ? `${formatUsd(l.used)} of ${formatUsd(l.limit)} used` : `${formatUsd(l.used)} used`;
			return l.limit !== null ? `${count(l.used)} of ${count(l.limit)} ${l.unit} used` : `${count(l.used)} ${l.unit} used`;
		}
		if (l.usedFraction !== null) return `${percent(l.usedFraction)}% used`;
		return "Usage not reported";
	}
</script>

<IconButton
	size="bar"
	label={agentId ? "Usage and limits" : "Usage unavailable until the agent starts"}
	icon={Icons.Gauge}
	disabled={!agentId}
	aria-haspopup="dialog"
	aria-expanded={open}
	onclick={() => (open ? hide(false) : void show())}
	{@attach ref}
/>

<Popover {anchor} {open} placement="bottom-end" role="dialog" label="Usage and Limits" bind:panel ondismiss={(how) => hide(how === "escape")}>
	<div class="usage">
		<div class="row">
			<h2>Usage and Limits</h2>
			{#if loading && usage}
				<span class="busy meta" role="status"><Spinner size="sm" />Updating…</span>
			{/if}
		</div>

		{#if loadError}
			<div class="error-row">
				<p class="field-error" role="alert">Couldn't load usage. {loadError}</p>
				<AsyncButton size="sm" variant="secondary" action={load} pendingLabel="Checking…">Retry</AsyncButton>
			</div>
		{/if}

		{#if !usage}
			{#if loading}
				<p class="busy meta" role="status"><Spinner size="sm" />Checking account limits…</p>
			{/if}
		{:else}
			<section class="section">
				{#if model}
					<p class="model">
						<span class="truncate">{model.name ?? model.id}</span>
						<span class="meta">{model.provider}</span>
					</p>
				{/if}

				{#if usage.limitsError !== null}
					<div class="error-row">
						<p class="field-error" role="alert">Couldn't load account limits. {usage.limitsError}</p>
						<AsyncButton size="sm" variant="secondary" action={load} pendingLabel="Checking…">Retry</AsyncButton>
					</div>
				{:else if limits.length === 0}
					<p class="meta">
						{#if model}
							No rate-limit windows are reported for {model.provider}. API-key providers may not expose them.
						{:else}
							No account limits are available. This chat's usage is still shown below.
						{/if}
					</p>
				{:else}
					{#each providers as p (p.provider)}
						{#if p.account || providers.length > 1}
							<p class="meta truncate">
								{p.provider === model?.provider ? (p.account ?? p.provider) : `${p.provider}${p.account ? ` · ${p.account}` : ""}`}
							</p>
						{/if}
						{#each p.limits as limit (limit.id)}
							<div class="limit">
								<div class="row">
									<span>{limit.label}</span>
									<span class="value">{limitValue(limit)}</span>
								</div>
								{#if limit.usedFraction !== null}
									<div
										class="track"
										role="progressbar"
										aria-label="{limit.label} used"
										aria-valuemin={0}
										aria-valuemax={100}
										aria-valuenow={percent(limit.usedFraction)}
									>
										<div class="fill" style:--fraction={clamp(limit.usedFraction)}></div>
									</div>
								{/if}
								{#if limit.resetsAt !== null}
									<span class="meta">{resetsIn(limit.resetsAt)}</span>
								{/if}
							</div>
						{/each}
					{/each}
				{/if}
			</section>

			<section class="section chat">
				<h3>This chat</h3>
				{#if !noShares}
					<p class="meta">Per-chat shares are estimates; other account activity during the same window may be included.</p>
					{#each shareRows as { limit, share } (limit.id)}
						<div class="row">
							<span>Share of {limit.windowLabel ?? limit.label}</span>
							<span class="value">
								{approxPercent(share)} of {limit.windowLabel ? windowName(limit.windowLabel) : limit.label}
							</span>
						</div>
					{/each}
				{/if}

				{#if !stats}
					<p class="meta">
						No chat usage has been recorded yet. Send a message after OMP starts to see tokens, cost, and context use.
					</p>
				{:else}
					{#if noShares}
						<p class="meta">No window share has been estimated for this chat yet.</p>
					{/if}
					<div class="limit">
						<div class="row">
							<span>Tokens</span>
							<span class="value">{count(stats.tokens.total)}</span>
						</div>
						<span class="meta">
							Input {count(stats.tokens.input)} · Output {count(stats.tokens.output)} · Cache read {count(stats.tokens.cacheRead)}
							· Cache write {count(stats.tokens.cacheWrite)}
						</span>
					</div>
					<div class="row">
						<span>Cost</span>
						<span class="value">{formatUsd(stats.cost, true)}</span>
					</div>
					{#if stats.context}
						{@const ctx = stats.context}
						<div class="limit">
							<div class="row">
								<span>Context</span>
								<span class="value">{percent(ctx.fraction)}% · {count(ctx.tokens)} / {count(ctx.window)} tokens</span>
							</div>
							<div
								class="track"
								role="progressbar"
								aria-label="Context window used"
								aria-valuemin={0}
								aria-valuemax={100}
								aria-valuenow={percent(ctx.fraction)}
							>
								<div class="fill" style:--fraction={clamp(ctx.fraction)}></div>
							</div>
						</div>
					{/if}
				{/if}

				{#if fetchedAt !== null}
					<p class="meta">Limits checked at {new Date(fetchedAt).toLocaleTimeString()}</p>
				{/if}
			</section>
		{/if}
	</div>
</Popover>

<style>
	.usage {
		display: grid;
		gap: var(--sp-3);
		min-width: 0;
		inline-size: min(calc(var(--menu-min-w) * 2), calc(100vw - var(--sp-4)));
		padding: var(--sp-2);
	}
	h2,
	h3,
	p {
		margin: 0;
	}
	h2,
	h3 {
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.section,
	.limit {
		display: grid;
		gap: var(--sp-2);
		min-width: 0;
	}
	.limit {
		gap: var(--sp-1);
	}
	.chat {
		border-block-start: var(--border);
		padding-block-start: var(--sp-3);
	}
	.row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--sp-2);
		min-width: 0;
		& > :first-child {
			min-width: 0;
			overflow-wrap: anywhere;
		}
	}
	.value {
		text-align: right;
		font-variant-numeric: tabular-nums;
		flex: none;
	}
	.model > .truncate {
		min-width: 0;
	}
	.model {
		display: flex;
		align-items: baseline;
		gap: var(--sp-2);
		min-width: 0;
		font-weight: 500;
	}
	.busy {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
	}
	.error-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-2);
		.field-error {
			margin-top: 0;
		}
	}
	.track {
		height: var(--sp-1);
		border-radius: var(--radius-full);
		overflow: hidden;
		color: var(--fg-muted);
		background: oklch(from var(--fg-muted) l c h / 0.16);
	}
	.fill {
		inline-size: calc(var(--fraction) * 100%);
		block-size: 100%;
		background: currentColor;
	}
</style>
