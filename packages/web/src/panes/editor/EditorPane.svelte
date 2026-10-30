<script lang="ts">
	import { Compartment, EditorState } from "@codemirror/state";
	import { EditorView, keymap } from "@codemirror/view";
	import type { FsFile, FsWriteConflict } from "@romp/protocol";
	import { basicSetup } from "codemirror";
	import { onDestroy, untrack } from "svelte";
	import { api, ApiFailure, errorMessage } from "../../lib/api";
	import { net } from "../../lib/conn/net.svelte";
	import { basename, formatSize, tildify } from "../../lib/format";
	import { Icons } from "../../lib/icons";
	import type { PaneContext } from "../../lib/shell/pane.svelte";
	import { session } from "../../lib/shell/session.svelte";
	import type { SaveState, WindowOf } from "../../lib/shell/types";
	import { viewport } from "../../lib/shell/viewport.svelte";
	import Banner from "../../lib/ui/Banner.svelte";
	import Button from "../../lib/ui/Button.svelte";
	import EmptyState from "../../lib/ui/EmptyState.svelte";
	import Skeleton from "../../lib/ui/Skeleton.svelte";
	import { toast } from "../../lib/ui/toast.svelte";
	import { isImage } from "../files/fileKind";
	import { highlightFor, languageFor, tokenTheme } from "./cm";

	let { win, pane }: { win: WindowOf<"editor">; pane: PaneContext<"editor"> } = $props();

	const AUTOSAVE_MS = 800;

	const path = $derived(win.props.path);
	const name = $derived(basename(path));

	let file: FsFile | null = $state(null);
	let loadError: { message: string; notFound: boolean } | null = $state(null);
	let save: SaveState = $state("saved");
	/** Disk mtime from a 409; set while the conflict banner is up. */
	let conflictMtime: number | null = $state(null);

	let host = $state<HTMLDivElement>();
	let view: EditorView | null = null;
	/** mtime of the disk version our buffer is based on. */
	let baseMtime = 0;
	let timer: number | undefined;
	let saving = false;
	/** The document changed while a save was in flight. */
	let editedDuringSave = false;

	const language = new Compartment();
	const wrapping = new Compartment();
	const highlight = new Compartment();

	$effect(() => {
		pane.status.save = file?.content != null && !loadError ? save : null;
		pane.status.retrySave = save === "failed" ? () => void runSave() : null;
		pane.status.subtitle = tildify(path, session.me?.home);
	});

	onDestroy(() => {
		clearTimeout(timer);
		if (view && (save === "unsaved" || save === "offline" || save === "failed")) void runSave();
		view?.destroy();
		pane.status.save = null;
		pane.status.retrySave = null;
	});

	async function load(target: string) {
		file = null;
		loadError = null;
		conflictMtime = null;
		try {
			const f = await api.fs.read(target);
			if (target !== path) return;
			file = f;
			baseMtime = f.mtimeMs;
			save = "saved";
		} catch (err) {
			loadError = {
				message: errorMessage(err),
				notFound: err instanceof ApiFailure && err.status === 404,
			};
		}
	}

	$effect(() => {
		const target = path;
		untrack(() => void load(target));
	});

	// Build the editor once the text is loaded (and rebuild for another file).
	$effect(() => {
		const el = host;
		const f = file;
		if (!el || !f || f.content === null) return;
		const doc = f.content;
		untrack(() => {
			view?.destroy();
			view = new EditorView({
				parent: el,
				state: EditorState.create({
					doc,
					extensions: [
						basicSetup,
						keymap.of([
							{
								key: "Mod-s",
								run: () => {
									void runSave();
									return true;
								},
							},
						]),
						tokenTheme,
						highlight.of(highlightFor(viewport.dark)),
						language.of([]),
						wrapping.of(viewport.layout === "phone" ? EditorView.lineWrapping : []),
						EditorView.updateListener.of((u) => {
							if (u.docChanged) changed();
							if (u.focusChanged && !u.view.hasFocus && save === "unsaved") void runSave();
						}),
					],
				}),
			});
			const v = view;
			void languageFor(f.path).then((ext) => {
				if (ext && view === v) v.dispatch({ effects: language.reconfigure(ext) });
			});
		});
	});

	$effect(() => {
		const wrap = viewport.layout === "phone";
		const dark = viewport.dark;
		untrack(() =>
			view?.dispatch({
				effects: [
					wrapping.reconfigure(wrap ? EditorView.lineWrapping : []),
					highlight.reconfigure(highlightFor(dark)),
				],
			}),
		);
	});

	$effect(() => pane.onFocusRequest(() => view?.focus()));

	function changed() {
		if (saving) editedDuringSave = true;
		if (save !== "conflict") save = net.offline ? "offline" : "unsaved";
		clearTimeout(timer);
		if (save !== "conflict") timer = window.setTimeout(() => void runSave(), AUTOSAVE_MS);
	}

	async function runSave(expected = baseMtime) {
		clearTimeout(timer);
		if (!view || saving || save === "conflict" && expected === baseMtime) return;
		saving = true;
		editedDuringSave = false;
		save = "saving";
		const content = view.state.doc.toString();
		try {
			const res = await api.fs.write({ path, content, expectedMtimeMs: expected });
			baseMtime = res.mtimeMs;
			conflictMtime = null;
			save = editedDuringSave ? "unsaved" : "saved";
		} catch (err) {
			if (err instanceof ApiFailure && err.status === 409) {
				conflictMtime = (err.body as unknown as FsWriteConflict).mtimeMs;
				save = "conflict";
			} else if (err instanceof ApiFailure && err.status === 0) {
				save = "offline";
			} else {
				save = "failed";
				toast({ message: errorMessage(err), tone: "danger" });
			}
		} finally {
			saving = false;
		}
		if (save === "unsaved") timer = window.setTimeout(() => void runSave(), AUTOSAVE_MS);
	}

	function keepMine() {
		if (conflictMtime === null) return;
		const disk = conflictMtime;
		save = "unsaved";
		void runSave(disk);
	}

	async function loadDisk() {
		try {
			const f = await api.fs.read(path);
			if (!view || f.content === null) return;
			// One transaction, so a single undo brings the user's text back.
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: f.content } });
			clearTimeout(timer);
			baseMtime = f.mtimeMs;
			conflictMtime = null;
			save = "saved";
		} catch (err) {
			toast({ message: errorMessage(err), tone: "danger" });
		}
	}

	// Saves pending edits when the tab is hidden and when the gateway comes back.
	$effect(() => {
		const onHide = () => {
			if (document.visibilityState === "hidden" && (save === "unsaved" || save === "offline")) void runSave();
		};
		document.addEventListener("visibilitychange", onHide);
		return () => document.removeEventListener("visibilitychange", onHide);
	});

	$effect(() => {
		if (!net.offline && save === "offline") untrack(() => void runSave());
	});
</script>

<div class="editor">
	{#if conflictMtime !== null}
		<Banner tone="warning" icon={Icons.Warn} text="{name} changed on disk since you opened it.">
			{#snippet actions()}
				<Button size="sm" onclick={keepMine}>Keep mine</Button>
				<Button size="sm" variant="primary" onclick={loadDisk}>Load disk version</Button>
			{/snippet}
		</Banner>
	{/if}
	{#if loadError}
		{#if loadError.notFound}
			<EmptyState icon={Icons.File} title="{tildify(path, session.me?.home)} no longer exists">
				{#snippet actions()}
					<Button onclick={() => pane.close()}>Close window</Button>
				{/snippet}
			</EmptyState>
		{:else}
			<EmptyState icon={Icons.Warn} title="Couldn't open {name}" text={loadError.message}>
				{#snippet actions()}
					<Button variant="primary" onclick={() => load(path)}>Retry</Button>
				{/snippet}
			</EmptyState>
		{/if}
	{:else if !file}
		<Skeleton preset="lines" mono gutter count={12} />
	{:else if file.content === null}
		{#if isImage(name)}
			<div class="image"><img src={api.fs.rawUrl(path)} alt={name} /></div>
		{:else}
			<EmptyState
				icon={Icons.File}
				title="Can't edit {name} here"
				text="{formatSize(file.size)} · {file.tooLarge ? 'larger than 5 MiB' : 'binary file'}"
			>
				{#snippet actions()}
					<a class="raw" href={api.fs.rawUrl(path)} target="_blank" rel="noopener">Open raw</a>
				{/snippet}
			</EmptyState>
		{/if}
	{:else}
		<div class="cm" bind:this={host}></div>
	{/if}
</div>

<style>
	.editor {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}
	.cm {
		flex: 1;
		min-height: 0;
		:global(.cm-editor) {
			height: 100%;
		}
	}
	.image {
		flex: 1;
		overflow: auto;
		padding: var(--sp-4);
		display: grid;
		place-items: center;
		img {
			max-width: 100%;
		}
	}
	.raw {
		font-weight: 500;
	}
</style>
