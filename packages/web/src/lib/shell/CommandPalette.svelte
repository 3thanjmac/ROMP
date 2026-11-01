<script lang="ts">
	import type { AgentInfo, TaskInfo } from "@romp/protocol";
	import { api, errorMessage } from "../api";
	import { tildify, untildify } from "../format";
	import { Icons, type IconComponent, KIND_ICON } from "../icons";
	import Dialog from "../ui/Dialog.svelte";
	import Icon from "../ui/Icon.svelte";
	import { toast } from "../ui/toast.svelte";
	import { fuzzyFilter } from "./fuzzy";
	import { LAUNCH_ITEMS, attach, launch, launchCwd, openAgent, type RunningSession, runningSessions } from "./launcherItems";
	import { WIDTH_LABELS, WIDTH_PRESETS } from "./layout";
	import { session } from "./session.svelte";
	import { displayTitle, shell } from "./shell.svelte";
	import { frameUi } from "./ui.svelte";

	type Section = "Windows" | "New" | "Running sessions" | "Tasks" | "Commands";
	interface Entry {
		key: string;
		section: Section;
		label: string;
		meta?: string;
		icon: IconComponent;
		run: () => void;
	}

	const SECTIONS: Section[] = ["Windows", "New", "Running sessions", "Tasks", "Commands"];

	let query = $state("");
	let selected = $state(0);
	let cwd = $state("");
	let pathMode: "cwd" | "file" | null = $state(null);
	let running: RunningSession[] = $state([]);
	let tasks: TaskInfo[] = $state([]);
	let agents: AgentInfo[] = $state([]);
	let input = $state<HTMLInputElement>();
	let list = $state<HTMLElement>();

	const home = $derived(session.me?.home);

	$effect(() => {
		if (!frameUi.palette) return;
		query = "";
		selected = 0;
		pathMode = null;
		cwd = launchCwd();
		let live = true;
		runningSessions().then((r) => live && (running = r), () => {});
		api.tasks.list().then((t) => live && (tasks = t), () => {});
		api.agents.list().then((a) => live && (agents = a), () => {});
		return () => {
			live = false;
		};
	});

	function close() {
		frameUi.palette = false;
	}

	async function openTaskAgent(task: TaskInfo) {
		const existing = agents.find((a) => !a.exited && a.task?.repo === task.repo && a.task.slug === task.slug);
		try {
			const agent = existing ?? (await api.agents.create({ cwd: task.path, title: task.title }));
			openAgent(agent.id, agent.cwd);
		} catch (err) {
			toast({ message: errorMessage(err), tone: "danger" });
		}
	}

	const entries: Entry[] = $derived.by(() => {
		const out: Entry[] = [];
		for (const ws of shell.state.workspaces) {
			for (const win of ws.windows) {
				out.push({
					key: `w:${win.id}`,
					section: "Windows",
					label: displayTitle(win),
					meta: ws.name,
					icon: KIND_ICON[win.kind],
					run: () => shell.focus(win.id, { keyboard: true }),
				});
			}
		}
		for (const item of LAUNCH_ITEMS) {
			out.push({
				key: `n:${item.kind}`,
				section: "New",
				label: item.label,
				meta: item.kind === "terminal" || item.kind === "agent" || item.kind === "files" ? tildify(cwd, home) : undefined,
				icon: item.icon,
				run: () => {
					if (item.kind === "open-file") {
						startPath("file");
						return;
					}
					launch(item.kind, cwd, true);
				},
			});
		}
		for (const s of running) {
			out.push({
				key: `r:${s.info.id}`,
				section: "Running sessions",
				label: s.info.title || (s.kind === "terminal" ? "Terminal" : "Agent"),
				meta: tildify(s.info.cwd, home),
				icon: KIND_ICON[s.kind],
				run: () => attach(s),
			});
		}
		for (const t of tasks) {
			if (t.status === "landed") continue;
			out.push({
				key: `t:${t.repo}/${t.slug}`,
				section: "Tasks",
				label: t.title,
				meta: t.repo,
				icon: Icons.Agent,
				run: () => void openTaskAgent(t),
			});
		}
		const cmd = (key: string, label: string, icon: IconComponent, run: () => void) =>
			out.push({ key: `c:${key}`, section: "Commands", label, icon, run });
		cmd("mode", "Toggle layout mode", shell.active.mode === "scroll" ? Icons.ModeTile : Icons.ModeScroll, () =>
			shell.toggleMode(),
		);
		cmd("rename", "Rename workspace", Icons.Rename, () => (frameUi.renameWorkspace = shell.active.id));
		cmd("new-ws", "New workspace", Icons.Add, () => shell.addWorkspace());
		if (shell.focusedWindow && shell.active.mode === "scroll") {
			WIDTH_PRESETS.forEach((w, i) => cmd(`width:${i}`, `Width: ${WIDTH_LABELS[i]}`, Icons.ModeScroll, () => shell.setWidth(shell.active.focusedId!, w)));
		}
		cmd("shortcuts", "Keyboard shortcuts", Icons.Shortcuts, () => (frameUi.shortcuts = true));
		cmd("settings", "Settings", Icons.Settings, () => (frameUi.settings = true));
		return out;
	});

	const results = $derived.by(() => {
		const matched = fuzzyFilter(entries, query, (e) => `${e.label} ${e.meta ?? ""}`);
		// Keep sections in a fixed order; within a section, best match first.
		return SECTIONS.flatMap((s) => matched.filter((e) => e.section === s));
	});

	$effect(() => {
		void query;
		selected = 0;
	});

	$effect(() => {
		const el = list?.querySelector<HTMLElement>(`[data-index="${selected}"]`);
		el?.scrollIntoView({ block: "nearest" });
	});

	function run(entry: Entry | undefined) {
		if (!entry) return;
		if (entry.key === "n:open-file") {
			entry.run();
			return;
		}
		close();
		entry.run();
	}

	function newTerminalHere() {
		close();
		launch("terminal", cwd, true);
	}

	function startPath(mode: "cwd" | "file") {
		pathMode = mode;
		query = mode === "file" ? `${tildify(cwd, home)}/` : tildify(cwd, home);
		input?.focus();
	}

	function onkeydown(e: KeyboardEvent) {
		if (pathMode) {
			if (e.key === "Enter") {
				e.preventDefault();
				const path = untildify(query.trim(), home);
				if (!path) return;
				if (pathMode === "file") {
					close();
					launch("open-file", path, true);
				} else {
					cwd = path.replace(/(.)\/+$/, "$1");
					pathMode = null;
					query = "";
				}
			} else if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				pathMode = null;
				query = "";
			}
			return;
		}
		const count = results.length || 1;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			selected = (selected + 1) % count;
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			selected = (selected - 1 + count) % count;
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (results.length) run(results[selected]);
			else newTerminalHere();
		}
	}
</script>

<Dialog bind:open={frameUi.palette} variant="palette" label="Command palette">
	<div class="palette">
		<div class="search">
			<Icon icon={Icons.Search} />
			<input
				bind:this={input}
				bind:value={query}
				{onkeydown}
				placeholder={pathMode === "file" ? "Path of the file to open" : pathMode === "cwd" ? "Folder for new terminals and agents" : "Open a window, switch, or run a command"}
				aria-label="Command"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				class:mono={pathMode !== null}
			/>
			{#if !pathMode}
				<button class="cwd meta mono truncate" onclick={() => startPath("cwd")}>in {tildify(cwd, home)}</button>
			{/if}
		</div>
		{#if pathMode}
			<p class="hint meta">Enter to {pathMode === "file" ? "open the file" : "use this folder"}, Esc to go back.</p>
		{:else}
			<div class="results" role="listbox" aria-label="Results" bind:this={list}>
				{#each results as entry, i (entry.key)}
					{#if i === 0 || results[i - 1]?.section !== entry.section}
						<div class="section meta" role="presentation">{entry.section}</div>
					{/if}
					<button
						role="option"
						class="row"
						aria-selected={i === selected}
						data-index={i}
						tabindex="-1"
						onpointermove={() => (selected = i)}
						onclick={() => run(entry)}
					>
						<Icon icon={entry.icon} />
						<span class="label truncate">{entry.label}</span>
						{#if entry.meta}<span class="meta truncate end">{entry.meta}</span>{/if}
					</button>
				{:else}
					<p class="empty muted">No matches for "{query}"</p>
					<button role="option" class="row" aria-selected="true" onclick={newTerminalHere}>
						<Icon icon={Icons.Terminal} />
						<span class="label">New terminal in {tildify(cwd, home)}</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>
</Dialog>

<style>
	.palette {
		display: flex;
		flex-direction: column;
		min-height: 0;
		max-height: var(--palette-max-h);
	}
	.search {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: var(--sp-2) var(--sp-3);
		border-block-end: var(--border);
		color: var(--fg-muted);
		input {
			flex: 1;
			border: 0;
			background: none;
			padding-inline: 0;
			&:focus {
				border: 0;
			}
		}
	}
	.cwd {
		max-width: var(--path-chip-max);
		padding: 0 var(--sp-2);
		border-radius: var(--radius-full);
		border: var(--border);
		&:hover {
			background: var(--surface-3);
		}
	}
	.hint {
		padding: var(--sp-3);
	}
	.results {
		overflow-y: auto;
		padding: var(--sp-1);
		min-height: 0;
	}
	.section {
		padding: var(--sp-2) var(--sp-2) var(--sp-1);
		font-weight: 500;
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		width: 100%;
		min-height: var(--row-h);
		padding: 0 var(--sp-2);
		border-radius: var(--radius-sm);
		color: var(--fg);
		:global(.icon) {
			color: var(--fg-muted);
		}
		&[aria-selected="true"] {
			background: var(--surface-3);
		}
	}
	.label {
		flex: 1;
	}
	.end {
		max-width: 40%;
		text-align: end;
	}
	.empty {
		padding: var(--sp-3) var(--sp-2) var(--sp-1);
		font-size: var(--text-sm);
	}
</style>
