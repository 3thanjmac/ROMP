<script lang="ts">
	import type { AgentUsage, UsageLimit } from "@romp/protocol";
	import { untrack } from "svelte";
	import { api, errorMessage } from "../api";
	import { approxPercent, formatUsd, resetsIn, windowName } from "../format";
	import { Icons } from "../icons";
	import AsyncButton from "../ui/AsyncButton.svelte";
	import Button from "../ui/Button.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import IconButton from "../ui/IconButton.svelte";
	import Spinner from "../ui/Spinner.svelte";

	let { agentId }: { agentId: string | null } = $props();

	let open = $state(false);

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

	function show() {
		open = true;
		void load();
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
		if (l.unit === "percent" && l.usedFraction !== null) return `${percent(l.usedFraction)}%`;
		if (l.used !== null) {
			if (l.unit === "usd") return l.limit !== null ? `${formatUsd(l.used)} of ${formatUsd(l.limit)}` : formatUsd(l.used);
			return l.limit !== null ? `${count(l.used)} of ${count(l.limit)} ${l.unit}` : `${count(l.used)} ${l.unit}`;
		}
		if (l.usedFraction !== null) return `${percent(l.usedFraction)}%`;
		return "Not reported";
	}
</script>

<IconButton
	size="bar"
	label={agentId ? "Usage and limits" : "Usage unavailable until the agent starts"}
	icon={Icons.Gauge}
	disabled={!agentId}
	aria-haspopup="dialog"
	aria-expanded={open}
	onclick={show}
/>

<Dialog bind:open label="Usage and Limits">
	<header class="top">
		<Button variant="ghost" size="sm" icon={Icons.Back} onclick={() => (open = false)}>Back</Button>
		<h2 class="truncate">Usage and Limits</h2>
		{#if loading && usage}
			<span class="busy meta" role="status"><Spinner size="sm" />Updating…</span>
		{/if}
	</header>

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
		<section>
			<div class="heading">
				<h3>Account limits</h3>
				{#if model}<span class="meta truncate">{model.name ?? model.id} · {model.provider}</span>{/if}
			</div>

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
				<table>
					<thead>
						<tr>
							<th scope="col">Limit</th>
							<th scope="col" class="num" colspan="2">Used</th>
							<th scope="col" class="num">Resets</th>
						</tr>
					</thead>
					{#each providers as p (p.provider)}
						<tbody>
							{#if p.account || providers.length > 1}
								<tr class="group">
									<th scope="rowgroup" colspan="4" class="meta truncate">
										{p.provider === model?.provider ? (p.account ?? p.provider) : `${p.provider}${p.account ? ` · ${p.account}` : ""}`}
									</th>
								</tr>
							{/if}
							{#each p.limits as limit (limit.id)}
								<tr>
									<th scope="row">{limit.label}</th>
									<td class="bar">
										{#if limit.usedFraction !== null}
											<span
												class="track"
												role="progressbar"
												aria-label="{limit.label} used"
												aria-valuemin={0}
												aria-valuemax={100}
												aria-valuenow={percent(limit.usedFraction)}
											>
												<span class="fill" style:--fraction={clamp(limit.usedFraction)}></span>
											</span>
										{/if}
									</td>
									<td class="num">{limitValue(limit)}</td>
									<td class="num meta">{limit.resetsAt !== null ? resetsIn(limit.resetsAt) : "No reset"}</td>
								</tr>
							{/each}
						</tbody>
					{/each}
				</table>
			{/if}
		</section>

		<section>
			<h3>This chat</h3>
			{#if !stats && noShares}
				<p class="meta">
					No chat usage has been recorded yet. Send a message after OMP starts to see tokens, cost, and context use.
				</p>
			{:else}
				<table>
					<tbody>
						{#if stats}
							<tr>
								<th scope="row">Tokens</th>
								<td class="num">{count(stats.tokens.total)}</td>
							</tr>
							<tr class="sub">
								<th scope="row">Input</th>
								<td class="num">{count(stats.tokens.input)}</td>
							</tr>
							<tr class="sub">
								<th scope="row">Output</th>
								<td class="num">{count(stats.tokens.output)}</td>
							</tr>
							<tr class="sub">
								<th scope="row">Cache read</th>
								<td class="num">{count(stats.tokens.cacheRead)}</td>
							</tr>
							<tr class="sub">
								<th scope="row">Cache write</th>
								<td class="num">{count(stats.tokens.cacheWrite)}</td>
							</tr>
							<tr>
								<th scope="row">Cost</th>
								<td class="num">{formatUsd(stats.cost, true)}</td>
							</tr>
							{#if stats.context}
								{@const ctx = stats.context}
								<tr>
									<th scope="row">Context</th>
									<td class="num">
										<span class="used">
											<span
												class="track"
												role="progressbar"
												aria-label="Context window used"
												aria-valuemin={0}
												aria-valuemax={100}
												aria-valuenow={percent(ctx.fraction)}
											>
												<span class="fill" style:--fraction={clamp(ctx.fraction)}></span>
											</span>
											{percent(ctx.fraction)}% · {count(ctx.tokens)} / {count(ctx.window)}
										</span>
									</td>
								</tr>
							{/if}
						{/if}
						{#if !noShares}
							{#each shareRows as { limit, share } (limit.id)}
								<tr>
									<th scope="row">Share of {limit.windowLabel ? `${windowName(limit.windowLabel)} window` : limit.label}</th>
									<td class="num">{approxPercent(share)}</td>
								</tr>
							{/each}
						{/if}
					</tbody>
				</table>
			{/if}
			<p class="meta">
				{#if !noShares}Per-chat shares are estimates; other account activity during the same window may be included.{:else if stats}No window share has been estimated for this chat yet.{/if}
				{#if fetchedAt !== null}Limits checked at {new Date(fetchedAt).toLocaleTimeString()}.{/if}
			</p>
		</section>
	{/if}
</Dialog>

<style>
	.top,
	.heading {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-width: 0;
	}
	.top .busy {
		margin-inline-start: auto;
	}
	.heading {
		justify-content: space-between;
		align-items: baseline;
	}
	h3,
	p {
		margin: 0;
	}
	section {
		display: grid;
		gap: var(--sp-2);
		min-width: 0;
	}
	section + section {
		padding-block-start: var(--sp-3);
		border-block-start: var(--border);
	}
	table {
		inline-size: 100%;
		border-collapse: collapse;
		font-size: var(--text-sm);
	}
	th,
	td {
		padding-block: var(--sp-1);
		text-align: start;
		vertical-align: baseline;
	}
	th:not(:first-child),
	td {
		padding-inline-start: var(--sp-3);
	}
	thead th {
		font-size: var(--text-xs);
		font-weight: 500;
		color: var(--fg-muted);
		border-block-end: var(--border);
	}
	tbody th {
		font-weight: 400;
	}
	tbody tr + tr > * {
		border-block-start: var(--border);
	}
	.group th {
		padding-block-start: var(--sp-2);
	}
	.sub th {
		padding-inline-start: var(--sp-3);
		color: var(--fg-muted);
	}
	.sub td {
		color: var(--fg-muted);
	}
	.num {
		text-align: end;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.bar {
		vertical-align: middle;
	}
	.used {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-2);
	}
	.track {
		display: block;
		inline-size: var(--usage-bar-w);
		block-size: var(--sp-1);
		border-radius: var(--radius-full);
		overflow: hidden;
		color: var(--fg-muted);
		background: oklch(from var(--fg-muted) l c h / 0.16);
	}
	.fill {
		display: block;
		inline-size: calc(var(--fraction) * 100%);
		block-size: 100%;
		background: currentColor;
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
</style>
