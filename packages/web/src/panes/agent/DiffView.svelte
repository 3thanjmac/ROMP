<script lang="ts">
	import { parseDiff } from "../../lib/agent/tools";
	import type { FileDiff } from "../../lib/agent/types";

	/** `showPaths`: label each file (multi-file edits; single files already name the path in the card header). */
	let { diffs, showPaths }: { diffs: FileDiff[]; showPaths: boolean } = $props();

	const files = $derived(diffs.map(d => ({ path: d.path, lines: parseDiff(d.diff) })));
	const SIGN = { add: "+", del: "-", ctx: " ", gap: " " } as const;
</script>

<div class="diff">
	{#each files as file, f (f)}
		{#if showPaths && file.path}<div class="path meta mono truncate">{file.path}</div>{/if}
		<div class="rows" role="group" aria-label={file.path ? `Changes to ${file.path}` : "Changes"}>
			{#each file.lines as line, i (i)}
				<div class="row" data-kind={line.kind}>
					<span class="num">{line.num}</span><span class="sign">{SIGN[line.kind]}</span><span class="text"
						>{line.kind === "gap" ? line.text : line.text || " "}</span
					>
				</div>
			{/each}
		</div>
	{/each}
</div>

<style>
	.diff {
		display: grid;
		gap: var(--sp-1);
		min-width: 0;
	}
	.path {
		padding-inline: var(--sp-1);
	}
	.rows {
		overflow-x: auto;
		background: var(--inset);
		border-radius: var(--radius-sm);
		padding-block: var(--sp-1);
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		line-height: 1.6;
	}
	.row {
		display: flex;
		width: max-content;
		min-width: 100%;
		white-space: pre;
		&[data-kind="add"] {
			background: var(--success-soft);
			.sign {
				color: var(--success);
			}
		}
		&[data-kind="del"] {
			background: var(--danger-soft);
			.sign {
				color: var(--danger);
			}
		}
		&[data-kind="gap"] {
			color: var(--fg-subtle);
		}
	}
	.num {
		min-width: 4ch;
		padding-inline: var(--sp-1);
		text-align: end;
		color: var(--fg-subtle);
		user-select: none;
	}
	.sign {
		width: 2ch;
		text-align: center;
		user-select: none;
	}
	.text {
		padding-inline-end: var(--sp-2);
	}
</style>
