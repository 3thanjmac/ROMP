<script lang="ts">
	import type { FsEntry, FsList } from "@romp/protocol";
	import { untrack } from "svelte";
	import { api, ApiFailure, errorMessage } from "../../lib/api";
	import { net } from "../../lib/conn/net.svelte";
	import { basename, joinPath, tildify } from "../../lib/format";
	import { Icons } from "../../lib/icons";
	import type { PaneContext } from "../../lib/shell/pane.svelte";
	import { session } from "../../lib/shell/session.svelte";
	import type { WindowOf } from "../../lib/shell/types";
	import Banner from "../../lib/ui/Banner.svelte";
	import Button from "../../lib/ui/Button.svelte";
	import EmptyState from "../../lib/ui/EmptyState.svelte";
	import Icon from "../../lib/ui/Icon.svelte";
	import IconButton from "../../lib/ui/IconButton.svelte";
	import Skeleton from "../../lib/ui/Skeleton.svelte";
	import { toast } from "../../lib/ui/toast.svelte";
	import Breadcrumbs from "./Breadcrumbs.svelte";
	import { entryIcon, isImage } from "./fileKind";
	import FileRow from "./FileRow.svelte";
	import NameInput from "./NameInput.svelte";
	import UploadRow from "./UploadRow.svelte";
	import { UploadQueue } from "./uploads.svelte";

	let { win, pane }: { win: WindowOf<"files">; pane: PaneContext<"files"> } = $props();

	let listing: FsList | null = $state(null);
	let loadError: string | null = $state(null);
	let loading = $state(true);
	let now = $state(Date.now());
	/** Inline "new file / new folder" row. */
	let draft: { kind: "file" | "dir"; name: string; error: string | null } | null = $state(null);
	/** Inline rename: the entry path and the typed name. */
	let renaming: { path: string; name: string; error: string | null } | null = $state(null);

	const path = $derived(win.props.path);
	const home = $derived(session.me?.home ?? null);

	$effect(() => {
		pane.status.subtitle = tildify(path, home);
	});

	let controller: AbortController | null = null;

	async function load(target: string, quiet = false) {
		controller?.abort();
		const ac = new AbortController();
		controller = ac;
		if (!quiet) loading = true;
		try {
			const list = await api.fs.list(target, ac.signal);
			if (ac.signal.aborted) return;
			listing = list;
			loadError = null;
			now = Date.now();
		} catch (err) {
			if (ac.signal.aborted) return;
			// Offline keeps the last listing on screen under a banner.
			if (!(err instanceof ApiFailure && err.status === 0 && listing)) {
				loadError = errorMessage(err);
				listing = null;
			}
		} finally {
			if (!ac.signal.aborted) loading = false;
		}
	}

	$effect(() => {
		const target = path;
		draft = null;
		renaming = null;
		void load(target);
		return () => controller?.abort();
	});

	$effect(() => {
		const onVisible = () => {
			if (document.visibilityState === "visible") void load(path, true);
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	});

	// Coming back online refreshes the stale listing.
	let wasOffline = false;
	$effect(() => {
		const offline = net.offline;
		if (wasOffline && !offline) untrack(() => void load(path, true));
		wasOffline = offline;
	});

	// Files change underneath (editors, terminals, agents): refresh whenever the pane gains focus.
	$effect(() => {
		if (pane.focused) untrack(() => listing && void load(path, true));
	});

	function navigate(to: string) {
		pane.setProps({ path: to });
	}

	function open(entry: FsEntry) {
		if (entry.kind === "dir") navigate(entry.path);
		else if (isImage(entry.name)) pane.open({ kind: "browser", props: { url: api.fs.rawUrl(entry.path) } });
		else pane.open({ kind: "editor", props: { path: entry.path } });
	}

	function sortEntries(entries: FsEntry[]): FsEntry[] {
		return entries.toSorted((a, b) => {
			const ad = a.kind === "dir" ? 0 : 1;
			const bd = b.kind === "dir" ? 0 : 1;
			return ad - bd || a.name.localeCompare(b.name);
		});
	}

	async function create(name: string) {
		if (!draft || !listing) return;
		const kind = draft.kind;
		const target = joinPath(listing.path, name);
		const placeholder: FsEntry = { name, path: target, kind, size: 0, mtimeMs: Date.now() };
		const before = listing.entries;
		listing.entries = sortEntries([...before, placeholder]);
		const typed = draft;
		draft = null;
		try {
			await api.fs.op(kind === "dir" ? { op: "mkdir", path: target } : { op: "create", path: target });
			await load(path, true);
			if (kind === "file") pane.open({ kind: "editor", props: { path: target } });
		} catch (err) {
			if (listing) listing.entries = before;
			const message = errorMessage(err);
			toast({ message, tone: "danger" });
			draft = { kind, name: typed.name, error: message };
		}
	}

	async function rename(entry: FsEntry, name: string) {
		if (!listing || !renaming) return;
		if (name === entry.name) {
			renaming = null;
			return;
		}
		const to = joinPath(listing.path, name);
		const before = listing.entries;
		listing.entries = sortEntries(before.map((e) => (e.path === entry.path ? { ...e, name, path: to } : e)));
		renaming = null;
		try {
			await api.fs.op({ op: "rename", path: entry.path, to });
			await load(path, true);
		} catch (err) {
			if (listing) listing.entries = before;
			const message = errorMessage(err);
			toast({ message, tone: "danger" });
			renaming = { path: entry.path, name, error: message };
		}
	}

	async function trash(entry: FsEntry) {
		if (!listing) return;
		const before = listing.entries;
		listing.entries = before.filter((e) => e.path !== entry.path);
		try {
			const { trashId } = await api.fs.op({ op: "trash", path: entry.path });
			toast({
				message: `Moved ${entry.name} to trash`,
				action: trashId
					? {
							label: "Undo",
							run: () =>
								void api.fs
									.op({ op: "restore", trashId })
									.then(() => load(path, true))
									.catch((err) => toast({ message: errorMessage(err), tone: "danger" })),
						}
					: undefined,
			});
		} catch (err) {
			if (listing) listing.entries = before;
			toast({ message: errorMessage(err), tone: "danger" });
		}
	}

	function startDraft(kind: "file" | "dir") {
		renaming = null;
		draft = { kind, name: "", error: null };
	}

	let picker: HTMLInputElement | undefined = $state();
	const canUpload = $derived(!!listing && !net.offline);

	// Uploads landing while a refresh is in flight fold into one more refresh after it.
	let refreshing = false;
	let refreshAgain = false;
	async function refreshAfterUpload() {
		if (refreshing) {
			refreshAgain = true;
			return;
		}
		refreshing = true;
		try {
			do {
				refreshAgain = false;
				await load(path, true);
			} while (refreshAgain);
		} finally {
			refreshing = false;
		}
	}

	const uploads = new UploadQueue({
		existing: (dir) => (listing?.path === dir ? listing.entries.map((e) => e.name) : []),
		uploaded: (dir) => {
			if (dir === path) void refreshAfterUpload();
		},
		finished: (count, name) => toast(count === 1 ? `Uploaded ${name}` : `Uploaded ${count} files`),
	});
	// Uploads keep running across navigation; closing the pane cancels them.
	$effect(() => () => uploads.abortAll());

	const here = $derived(uploads.items.filter((u) => u.dir === path));
	const elsewhere = $derived(uploads.items.length - here.length);

	function picked(e: Event & { currentTarget: HTMLInputElement }) {
		const input = e.currentTarget;
		if (input.files) uploads.add(Array.from(input.files), path);
		// Cleared so picking the same file again still fires change.
		input.value = "";
	}

	/** dragenter/dragleave fire for every child the pointer crosses; the depth says when the drag really left. */
	let dragDepth = $state(0);
	const dropping = $derived(dragDepth > 0 && canUpload);
	const isFileDrag = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;

	function dragenter(e: DragEvent) {
		if (!isFileDrag(e)) return;
		e.preventDefault();
		dragDepth++;
	}

	function dragover(e: DragEvent) {
		if (!isFileDrag(e) || !e.dataTransfer) return;
		// Also keeps the browser from opening a file dropped here while uploads are unavailable.
		e.preventDefault();
		e.dataTransfer.dropEffect = canUpload ? "copy" : "none";
	}

	function dragleave(e: DragEvent) {
		if (isFileDrag(e) && dragDepth > 0) dragDepth--;
	}

	function drop(e: DragEvent) {
		if (!isFileDrag(e) || !e.dataTransfer) return;
		e.preventDefault();
		dragDepth = 0;
		if (!canUpload) return;
		const files: File[] = [];
		let folders = 0;
		for (const item of e.dataTransfer.items) {
			if (item.kind !== "file") continue;
			if (item.webkitGetAsEntry?.()?.isDirectory) {
				folders++;
				continue;
			}
			const file = item.getAsFile();
			if (file) files.push(file);
		}
		if (folders > 0) toast("Folders can't be uploaded yet");
		uploads.add(files, path);
	}
</script>

<div class="files">
	<div class="toolbar">
		<Breadcrumbs {path} {home} onnavigate={navigate} />
		<IconButton size="bar" label="Upload files" icon={Icons.Upload} disabled={!canUpload} onclick={() => picker?.click()} />
		<IconButton size="bar" label="New file" icon={Icons.FilePlus} disabled={!listing} onclick={() => startDraft("file")} />
		<IconButton size="bar" label="New folder" icon={Icons.FolderPlus} disabled={!listing} onclick={() => startDraft("dir")} />
		<input bind:this={picker} class="sr-only" type="file" multiple tabindex="-1" aria-hidden="true" onchange={picked} />
	</div>
	{#if listing && net.offline}
		<Banner tone="neutral" icon={Icons.Offline} text="Offline: showing the last loaded listing." />
	{/if}
	<div
		class="body"
		data-drop={dropping ? "" : undefined}
		role="presentation"
		ondragenter={dragenter}
		ondragover={dragover}
		ondragleave={dragleave}
		ondrop={drop}
	>
		{#if loading && !listing}
			<Skeleton preset="rows" count={8} />
		{:else if loadError || !listing}
			<EmptyState icon={Icons.Warn} title="Can't open {tildify(path, home)}" text={loadError}>
				{#snippet actions()}
					<Button onclick={() => load(path)}>Retry</Button>
					{#if home && path !== home}
						<Button variant="primary" icon={Icons.Home} onclick={() => navigate(home)}>Go to home</Button>
					{/if}
				{/snippet}
			</EmptyState>
		{:else}
			{#if dropping}
				<p class="drop-hint"><Icon icon={Icons.Upload} />Drop to upload to {path === home ? "~" : basename(path)}</p>
			{/if}
			{#if elsewhere > 0}
				<p class="elsewhere meta">
					{elsewhere === 1 ? "1 upload in another folder" : `${elsewhere} uploads in other folders`}
				</p>
			{/if}
			{#if draft}
				<NameInput
					icon={entryIcon({ name: draft.name, kind: draft.kind })}
					label={draft.kind === "dir" ? "New folder name" : "New file name"}
					bind:value={draft.name}
					error={draft.error}
					oncommit={create}
					oncancel={() => (draft = null)}
				/>
			{/if}
			{#if listing.entries.length === 0 && !draft && here.length === 0}
				<EmptyState icon={Icons.Folder} title="This folder is empty">
					{#snippet actions()}
						<Button icon={Icons.Upload} disabled={!canUpload} onclick={() => picker?.click()}>Upload files</Button>
						<Button icon={Icons.FilePlus} onclick={() => startDraft("file")}>New file</Button>
						<Button icon={Icons.FolderPlus} onclick={() => startDraft("dir")}>New folder</Button>
					{/snippet}
				</EmptyState>
			{:else}
				<ul class="list">
					{#each here as item (item.id)}
						<UploadRow
							{item}
							oncancel={() => uploads.cancel(item.id)}
							onreplace={() => uploads.replace(item.id)}
							onkeepboth={() => uploads.keepBoth(item.id)}
							onretry={() => uploads.retry(item.id)}
							ondismiss={() => uploads.dismiss(item.id)}
						/>
					{/each}
					{#if listing.parent}
						<li class="up">
							<button onclick={() => navigate(listing!.parent!)}><span class="meta">..</span></button>
						</li>
					{/if}
					{#each listing.entries as entry (entry.path)}
						{#if renaming?.path === entry.path}
							<NameInput
								icon={entryIcon(entry)}
								label="New name for {entry.name}"
								bind:value={renaming.name}
								error={renaming.error}
								oncommit={(name) => rename(entry, name)}
								oncancel={() => (renaming = null)}
							/>
						{:else}
							<FileRow
								{entry}
								{now}
								onopen={() => open(entry)}
								onrename={() => ((draft = null), (renaming = { path: entry.path, name: entry.name, error: null }))}
								ontrash={() => trash(entry)}
							/>
						{/if}
					{/each}
				</ul>
			{/if}
		{/if}
	</div>
</div>

<style>
	.files {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		height: var(--toolbar-h);
		padding-inline: var(--sp-2) var(--sp-1);
		border-block-end: var(--border);
		flex: none;
	}
	.body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		&[data-drop] {
			outline: var(--edge-w) solid var(--accent);
			outline-offset: calc(-1 * var(--edge-w));
		}
	}
	.drop-hint {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-height: var(--row-h);
		padding-inline: var(--sp-3);
		color: var(--accent);
		background: var(--accent-soft);
	}
	.elsewhere {
		padding: var(--sp-1) var(--sp-3);
	}
	.list {
		padding: 0 0 var(--sp-2);
	}
	.up {
		list-style: none;
		button {
			display: flex;
			align-items: center;
			width: 100%;
			min-height: var(--row-h);
			padding-inline: calc(var(--sp-3) + var(--icon-md) + var(--sp-2));
			&:hover {
				background: var(--surface-3);
			}
		}
	}
</style>
