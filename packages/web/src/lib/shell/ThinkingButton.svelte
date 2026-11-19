<script lang="ts">
	import { type ModelChoice, type ModelOption, THINKING_LEVELS, type ThinkingLevel } from "@romp/protocol";
	import { tick } from "svelte";
	import { api, errorMessage } from "../api";
	import { Icons } from "../icons";
	import AsyncButton from "../ui/AsyncButton.svelte";
	import type { Placement } from "../ui/floating";
	import IconButton from "../ui/IconButton.svelte";
	import Popover from "../ui/Popover.svelte";
	import Spinner from "../ui/Spinner.svelte";
	import Wheel, { type WheelOption } from "../ui/Wheel.svelte";
	import { viewport } from "./viewport.svelte";

	interface Props {
		/** The current choice; null while it loads. */
		value: ModelChoice | null;
		/** Offer "Default" on both wheels (a session not started yet): whatever OMP would pick. */
		allowDefault?: boolean;
		onchange: (choice: ModelChoice) => void;
		/** The panel opened: refresh `value` if it can change elsewhere. */
		onopen?: () => void;
		/** In-flight work shown in the panel header, e.g. "Switching…". */
		busy?: string | null;
		error?: string | null;
		/** Offered beside `error`. */
		onretry?: () => Promise<void>;
		size?: "bar" | "md";
		disabled?: boolean;
		/** Button label while `disabled`. */
		disabledLabel?: string;
		placement?: Placement;
		/** On a phone, dock the panel under this element (e.g. the whole composer), matching its width. */
		phoneAnchor?: HTMLElement | null;
	}

	let {
		value,
		allowDefault = false,
		onchange,
		onopen,
		busy = null,
		error = null,
		onretry,
		size = "md",
		disabled = false,
		disabledLabel,
		placement = "bottom-end",
		phoneAnchor = null,
	}: Props = $props();

	const docked = $derived(viewport.layout === "phone" && phoneAnchor !== null);

	const DEFAULT = "";
	const LEVEL_LABEL: Record<ThinkingLevel, string> = {
		off: "Off",
		minimal: "Minimal",
		low: "Low",
		medium: "Medium",
		high: "High",
		xhigh: "Extra high",
		max: "Max",
	};

	let open = $state(false);
	let anchor = $state<HTMLElement | null>(null);
	let panel = $state<HTMLElement | null>(null);

	let models = $state<ModelOption[] | null>(null);
	let modelsError = $state<string | null>(null);
	let loadingModels: Promise<void> | null = null;

	function loadModels(): Promise<void> {
		loadingModels ??= api.models
			.list()
			.then(
				(list) => {
					models = list;
					modelsError = null;
				},
				(err: unknown) => {
					modelsError = errorMessage(err);
				},
			)
			.finally(() => (loadingModels = null));
		return loadingModels;
	}

	async function show() {
		open = true;
		void loadModels();
		onopen?.();
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

	const keyOf = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

	/** The listed model `value` names, if OMP lists it. */
	const current = $derived.by(() => {
		const model = value?.model;
		return model ? (models?.find((m) => m.provider === model.provider && m.id === model.id) ?? null) : null;
	});

	/** Levels a model accepts; every level when it is unknown (the default model, or one OMP no longer lists). */
	function levelsFor(model: ModelOption | null): ThinkingLevel[] {
		return model ? ["off", ...model.thinking] : [...THINKING_LEVELS];
	}

	/** `level` moved to the nearest one `allowed` offers, ties going up. */
	function clampLevel(level: ThinkingLevel | null, allowed: ThinkingLevel[]): ThinkingLevel | null {
		if (level === null || allowed.includes(level)) return level;
		const rank = (l: ThinkingLevel) => THINKING_LEVELS.indexOf(l);
		const want = rank(level);
		return allowed.reduce((best, l) => {
			const d = Math.abs(rank(l) - want);
			const bestD = Math.abs(rank(best) - want);
			return d < bestD || (d === bestD && rank(l) > rank(best)) ? l : best;
		});
	}

	const modelOptions = $derived.by((): WheelOption[] => {
		const all = models ?? [];
		// Dated snapshots share a display name ("Claude Opus 4.5" twice): show their ids instead.
		const nameKey = (m: ModelOption) => `${m.provider}\n${m.name}`;
		const uses = new Map<string, number>();
		for (const m of all) uses.set(nameKey(m), (uses.get(nameKey(m)) ?? 0) + 1);
		const list: WheelOption[] = all.map((m) => ({
			value: keyOf(m),
			label: uses.get(nameKey(m)) === 1 ? m.name : m.id,
			detail: m.provider,
		}));
		const model = value?.model;
		if (model && !current) list.unshift({ value: keyOf(model), label: model.id, detail: model.provider });
		if (allowDefault) list.unshift({ value: DEFAULT, label: "Default" });
		return list;
	});

	const levelOptions = $derived.by((): WheelOption[] => {
		const levels = levelsFor(current).map((l) => ({ value: l, label: LEVEL_LABEL[l] }));
		return allowDefault ? [{ value: DEFAULT, label: "Default" }, ...levels] : levels;
	});

	function pickModel(key: string) {
		if (!value) return;
		const listed = models?.find((m) => keyOf(m) === key) ?? null;
		const model = key === DEFAULT ? null : listed ? { provider: listed.provider, id: listed.id } : value.model;
		onchange({ model, level: clampLevel(value.level, levelsFor(listed)) });
	}

	function pickLevel(level: string) {
		if (!value) return;
		onchange({ model: value.model, level: level === DEFAULT ? null : (level as ThinkingLevel) });
	}

	const summary = $derived.by(() => {
		if (!value) return null;
		const model = value.model ? (current?.name ?? value.model.id) : "Default model";
		const level = value.level ? `${LEVEL_LABEL[value.level]} thinking` : "default thinking";
		return `${model} · ${level}`;
	});
	const label = $derived(disabled && disabledLabel ? disabledLabel : summary ? `Model and thinking: ${summary}` : "Model and thinking");
</script>

<IconButton
	{size}
	{label}
	icon={Icons.Thinking}
	{disabled}
	aria-haspopup="dialog"
	aria-expanded={open}
	onclick={() => (open ? hide(false) : void show())}
	{@attach ref}
/>

<!-- On a phone the panel is nearly as wide as the screen, so it is centered (or docked under `phoneAnchor`) rather than hung off the button. -->
<Popover
	{anchor}
	{open}
	{placement}
	center={viewport.layout === "phone" && !docked}
	placeAt={docked ? phoneAnchor : null}
	matchWidth={docked}
	glass
	role="dialog"
	label="Model and Thinking"
	bind:panel
	ondismiss={(how) => hide(how === "escape")}
>
	<div class="thinking" class:docked>
		<div class="head">
			<h2>Model and Thinking</h2>
			{#if busy}
				<span class="busy meta" role="status"><Spinner size="sm" />{busy}</span>
			{/if}
		</div>

		{#if modelsError}
			<div class="error-row">
				<p class="field-error" role="alert">Couldn't load models. {modelsError}</p>
				<AsyncButton size="sm" variant="secondary" action={loadModels} pendingLabel="Loading…">Retry</AsyncButton>
			</div>
		{/if}
		{#if error}
			<div class="error-row">
				<p class="field-error" role="alert">{error}</p>
				{#if onretry}
					<AsyncButton size="sm" variant="secondary" action={onretry} pendingLabel="Loading…">Retry</AsyncButton>
				{/if}
			</div>
		{/if}

		{#if models && value}
			<div class="wheels">
				<div class="col">
					<span class="meta" aria-hidden="true">Model</span>
					<Wheel label="Model" options={modelOptions} value={value.model ? keyOf(value.model) : DEFAULT} onchange={pickModel} />
				</div>
				<div class="col">
					<span class="meta" aria-hidden="true">Thinking</span>
					<Wheel label="Thinking effort" options={levelOptions} value={value.level ?? DEFAULT} onchange={pickLevel} />
				</div>
			</div>
		{:else if !modelsError && !error}
			<!-- As tall as the wheels, so the panel opens on the side with room for them. -->
			<p class="busy meta loading" role="status"><Spinner size="sm" />Loading models…</p>
		{/if}
	</div>
</Popover>

<style>
	.thinking {
		display: grid;
		gap: var(--sp-3);
		inline-size: min(calc(var(--wheel-model-w) + var(--wheel-effort-w) + var(--sp-2) * 3), calc(100vw - var(--sp-4)));
		padding: var(--sp-2);
		&.docked {
			inline-size: auto;
		}
	}
	.head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--sp-2);
	}
	h2,
	p {
		margin: 0;
	}
	h2 {
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.wheels {
		display: grid;
		grid-template-columns: minmax(0, 1fr) var(--wheel-effort-w);
		gap: var(--sp-2);
	}
	.loading {
		align-items: start;
		min-block-size: calc(var(--wheel-row-h) * 6);
	}
	.col {
		display: grid;
		gap: var(--sp-1);
		min-width: 0;
		> .meta {
			padding-inline: var(--sp-2);
		}
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
