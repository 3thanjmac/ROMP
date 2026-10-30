<script lang="ts">
	import type { UiAnswer, UiRequest } from "../../lib/agent/types";
	import Button from "../../lib/ui/Button.svelte";

	interface Props {
		req: UiRequest;
		/** Answers can go out now (socket live). */
		live: boolean;
		onanswer: (answer: UiAnswer) => void;
		/** The request's timeout passed; OMP has already resolved it to its default. */
		onexpire: () => void;
	}

	let { req, live, onanswer, onexpire }: Props = $props();

	let now = $state(Date.now());
	const deadline = $derived(req.timeout ? req.receivedAt + req.timeout : null);
	const remaining = $derived(deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000)));

	$effect(() => {
		if (deadline === null) return;
		const timer = window.setInterval(() => {
			now = Date.now();
			if (now >= deadline) onexpire();
		}, 1000);
		return () => clearInterval(timer);
	});

	// Free-text fields: `input`, `editor`, and the "Other" answer of each `ask` question.
	// svelte-ignore state_referenced_locally
	let value = $state(req.method === "editor" ? (req.prefill ?? "") : "");
	let picked = $state<Record<string, string[]>>({});
	let other = $state<Record<string, string>>({});

	const heading = $derived(req.method === "ask" ? (req.questions.length === 1 ? req.questions[0]?.question : "The agent has questions") : req.title);

	function toggle(questionId: string, label: string, multi: boolean) {
		const current = picked[questionId] ?? [];
		picked[questionId] = multi
			? current.includes(label)
				? current.filter(l => l !== label)
				: [...current, label]
			: current[0] === label
				? []
				: [label];
	}

	const askReady = $derived(
		req.method === "ask" && req.questions.every(q => (picked[q.id]?.length ?? 0) > 0 || (other[q.id] ?? "").trim() !== ""),
	);

	function submitAsk(e: SubmitEvent) {
		e.preventDefault();
		if (req.method !== "ask" || !askReady) return;
		onanswer({
			answers: req.questions.map(q => {
				const custom = (other[q.id] ?? "").trim();
				return { id: q.id, selectedOptions: picked[q.id] ?? [], ...(custom ? { customInput: custom } : {}) };
			}),
		});
	}

	function submitText(e: SubmitEvent) {
		e.preventDefault();
		if (req.method === "input" || req.method === "editor") onanswer({ value });
	}
</script>

<section class="card" aria-labelledby="q-{req.id}">
	<div class="head">
		<h4 id="q-{req.id}">{heading}</h4>
		{#if remaining !== null}<span class="meta tabular">{remaining}s</span>{/if}
	</div>

	{#if req.method === "select"}
		<div class="options">
			{#each req.options as option, i (i)}
				<Button variant="secondary" disabled={!live} onclick={() => onanswer({ value: option })}>
					<span class="option">
						<span>{option}</span>
						{#if req.optionDetails?.[i]?.description}<span class="meta">{req.optionDetails[i].description}</span>{/if}
					</span>
				</Button>
			{/each}
		</div>
		<div class="actions">
			<Button variant="ghost" disabled={!live} onclick={() => onanswer({ cancelled: true })}>Skip</Button>
		</div>
	{:else if req.method === "confirm"}
		{#if req.message}<p class="message">{req.message}</p>{/if}
		<div class="actions">
			<Button variant="secondary" disabled={!live} onclick={() => onanswer({ confirmed: false })}>Cancel</Button>
			<Button variant="primary" disabled={!live} onclick={() => onanswer({ confirmed: true })}>Confirm</Button>
		</div>
	{:else if req.method === "input" || req.method === "editor"}
		<form onsubmit={submitText}>
			{#if req.method === "input"}
				<input
					type={req.secret ? "password" : "text"}
					bind:value
					placeholder={req.placeholder}
					aria-label={req.title || "Answer"}
					autocomplete="off"
				/>
			{:else}
				<textarea bind:value aria-label={req.title || "Answer"}></textarea>
			{/if}
			<div class="actions">
				<Button variant="secondary" disabled={!live} onclick={() => onanswer({ cancelled: true })}>Cancel</Button>
				<Button type="submit" variant="primary" disabled={!live}>Submit</Button>
			</div>
		</form>
	{:else if req.method === "ask"}
		<form onsubmit={submitAsk}>
			{#each req.questions as q (q.id)}
				<fieldset>
					{#if req.questions.length > 1}<legend>{q.header ?? q.question}</legend>{/if}
					{#if req.questions.length > 1 && q.header}<p class="message">{q.question}</p>{/if}
					<div class="options" role="group" aria-label={q.question}>
						{#each q.options as option, i (i)}
							<Button
								variant="secondary"
								aria-pressed={(picked[q.id] ?? []).includes(option.label)}
								onclick={() => toggle(q.id, option.label, q.multi === true)}
							>
								<span class="option">
									<span>{option.label}{q.recommended === i ? " (recommended)" : ""}</span>
									{#if option.description}<span class="meta">{option.description}</span>{/if}
								</span>
							</Button>
						{/each}
					</div>
					<input
						type="text"
						placeholder="Other answer"
						aria-label="Other answer to: {q.question}"
						autocomplete="off"
						value={other[q.id] ?? ""}
						oninput={e => (other[q.id] = e.currentTarget.value)}
					/>
				</fieldset>
			{/each}
			<div class="actions">
				<Button variant="secondary" disabled={!live} onclick={() => onanswer({ cancelled: true })}>Skip</Button>
				<Button type="submit" variant="primary" disabled={!live || !askReady}>Submit</Button>
			</div>
		</form>
	{/if}
</section>

<style>
	.card {
		display: grid;
		gap: var(--sp-2);
		padding: var(--sp-3);
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius-lg);
		min-width: 0;
	}
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--sp-2);
	}
	.message {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	form,
	fieldset {
		display: grid;
		gap: var(--sp-2);
		min-width: 0;
	}
	fieldset {
		border: 0;
		padding: 0;
		margin: 0;
	}
	legend {
		font-weight: 600;
		padding: 0;
		margin-block-end: var(--sp-1);
	}
	.options {
		display: grid;
		gap: var(--sp-1);
		:global(button) {
			width: 100%;
			min-height: var(--tap);
			justify-content: flex-start;
			text-align: start;
		}
		:global(button[aria-pressed="true"]) {
			border-color: var(--accent);
			background: var(--accent-soft);
		}
	}
	.option {
		display: grid;
		padding-block: var(--sp-1);
	}
	textarea {
		min-height: calc(3lh + var(--sp-2) * 2);
		max-height: calc(var(--field-max-h) + var(--sp-2) * 2);
		field-sizing: content;
		resize: vertical;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
	}
</style>
