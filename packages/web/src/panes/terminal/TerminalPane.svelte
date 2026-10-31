<script lang="ts">
	import type { TermClientMsg, TermServerMsg } from "@romp/protocol";
	import { FitAddon } from "@xterm/addon-fit";
	import { WebLinksAddon } from "@xterm/addon-web-links";
	import { Terminal } from "@xterm/xterm";
	import { onDestroy, tick, untrack } from "svelte";
	import { api, errorMessage } from "../../lib/api";
	import { Socket } from "../../lib/conn/socket.svelte";
	import { tildify } from "../../lib/format";
	import { Icons } from "../../lib/icons";
	import { isShellChord } from "../../lib/shell/keyboard";
	import type { PaneContext } from "../../lib/shell/pane.svelte";
	import { session } from "../../lib/shell/session.svelte";
	import type { WindowOf } from "../../lib/shell/types";
	import { viewport } from "../../lib/shell/viewport.svelte";
	import { terminalTheme, tokenPx } from "../../lib/theme";
	import Banner from "../../lib/ui/Banner.svelte";
	import Button from "../../lib/ui/Button.svelte";
	import EmptyState from "../../lib/ui/EmptyState.svelte";
	import Skeleton from "../../lib/ui/Skeleton.svelte";
	import { toast } from "../../lib/ui/toast.svelte";
	import ExtraKeys from "./ExtraKeys.svelte";
	import { applyModifiers, type ModState } from "./keys";
	import { type BufferText, copyText, snapshotBuffer, wordAt } from "./selection";

	let { win, pane }: { win: WindowOf<"terminal">; pane: PaneContext<"terminal"> } = $props();

	const CLIENTS_POLL_MS = 15_000;
	const SLOW_CONNECT_MS = 1000;
	const LONG_PRESS_MS = 500;
	/** Finger travel that turns a long-press into a scroll. */
	const LONG_PRESS_SLOP_PX = 8;
	const COPIED_MS = 1500;
	/** Wait after a long-press lifts, so the synthesized click lands before the word is selected. */
	const LIFT_SETTLE_MS = 50;

	let host: HTMLDivElement;
	let term: Terminal | null = null;
	let fit: FitAddon | null = null;
	let socket = $state<Socket<TermServerMsg, TermClientMsg> | null>(null);
	let replayed = $state(false);
	let slow = $state(false);
	let createError: string | null = $state(null);
	let creating = false;
	let exitCode: number | null = $state(null);
	let ctrl: ModState = $state("off");
	let alt: ModState = $state("off");
	/** Select mode: a frozen plain-text copy of the buffer, shown as a natively selectable layer. */
	let snapshot = $state.raw<BufferText | null>(null);
	let rowPx = $state(0);
	let layer: HTMLDivElement | undefined = $state();
	let pre: HTMLPreElement | undefined = $state();
	let hasSelection = $state(false);
	let copied = $state(false);
	let copiedTimer: number | undefined;
	let pasting = $state(false);
	let press: { id: number; x: number; y: number; timer: number } | null = null;

	const conn = $derived(socket?.state ?? "connecting");
	const termId = $derived(win.props.termId);

	$effect(() => {
		pane.status.conn = createError ? null : conn;
		pane.status.exitCode = exitCode;
		pane.status.subtitle = win.props.cwd ? tildify(win.props.cwd, session.me?.home) : null;
	});

	function size(): { cols: number; rows: number } {
		return { cols: term?.cols ?? 80, rows: term?.rows ?? 24 };
	}

	function sendResize() {
		if (!term) return;
		socket?.send({ t: "resize", cols: term.cols, rows: term.rows });
	}

	function refit() {
		if (!term || !fit || !host || host.clientWidth === 0 || host.clientHeight === 0) return;
		const before = `${term.cols}x${term.rows}`;
		fit.fit();
		if (`${term.cols}x${term.rows}` !== before) sendResize();
	}

	function input(data: string) {
		if (!socket || socket.state !== "live") return;
		const out = applyModifiers(data, ctrl !== "off", alt !== "off");
		if (ctrl === "latched") ctrl = "off";
		if (alt === "latched") alt = "off";
		socket.send({ t: "in", d: out });
	}

	async function paste() {
		if (!term || pasting || conn !== "live") return;
		pasting = true;
		exitSelect();
		try {
			// Called synchronously inside the tap, which iOS requires; it then shows its own Paste confirmation.
			const text = await navigator.clipboard.readText();
			if (text) term.paste(text);
			else toast("Clipboard is empty.");
		} catch {
			toast({ message: "Couldn't paste. Allow clipboard access and try again.", tone: "danger" });
		} finally {
			pasting = false;
		}
	}

	async function enterSelect() {
		if (!term || snapshot) return;
		const buffer = term.buffer.active;
		const screen = term.element?.querySelector(".xterm-screen");
		rowPx = screen && term.rows ? screen.clientHeight / term.rows : 0;
		snapshot = snapshotBuffer(buffer);
		term.blur();
		await tick();
		if (layer) layer.scrollTop = buffer.viewportY * rowPx;
	}

	function exitSelect() {
		if (!snapshot) return;
		if (ownedRange()) getSelection()?.removeAllRanges();
		snapshot = null;
		hasSelection = false;
		copied = false;
		clearTimeout(copiedTimer);
	}

	/** The selection as offsets into the snapshot text, when it lies inside the layer. */
	function ownedRange(): { start: number; end: number } | null {
		const sel = getSelection();
		const root = pre;
		if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
		const range = sel.getRangeAt(0);
		if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
		const offset = (node: Node, at: number) => {
			const r = document.createRange();
			r.setStart(root, 0);
			r.setEnd(node, at);
			return r.toString().length;
		};
		return { start: offset(range.startContainer, range.startOffset), end: offset(range.endContainer, range.endOffset) };
	}

	function selectWordAt(x: number, y: number) {
		const text = pre?.firstChild;
		const caret = document.caretRangeFromPoint(x, y);
		if (!snapshot || !text || caret?.startContainer !== text) return;
		const word = wordAt(snapshot.text, caret.startOffset);
		if (!word) return;
		const range = document.createRange();
		range.setStart(text, word[0]);
		range.setEnd(text, word[1]);
		getSelection()?.removeAllRanges();
		getSelection()?.addRange(range);
	}

	/** Everything up to the last non-blank character: the empty rows under the prompt are not worth copying. */
	function selectAll() {
		const text = pre?.firstChild;
		if (!snapshot || !text) return;
		const range = document.createRange();
		range.setStart(text, 0);
		range.setEnd(text, snapshot.text.trimEnd().length);
		getSelection()?.removeAllRanges();
		getSelection()?.addRange(range);
	}

	async function copySelection() {
		const range = ownedRange();
		if (!snapshot || !range) return;
		try {
			await navigator.clipboard.writeText(copyText(snapshot, range.start, range.end));
		} catch {
			toast({ message: "Couldn't copy. Use the system Copy option instead.", tone: "danger" });
			return;
		}
		copied = true;
		clearTimeout(copiedTimer);
		copiedTimer = window.setTimeout(() => (copied = false), COPIED_MS);
	}

	/** The system Copy callout copies the laid-out rows; rejoin soft-wrapped lines instead. */
	function nativeCopy(e: ClipboardEvent) {
		const range = ownedRange();
		if (!snapshot || !range || !e.clipboardData) return;
		e.preventDefault();
		e.clipboardData.setData("text/plain", copyText(snapshot, range.start, range.end));
	}

	/** Long-press on the terminal enters select mode with the word under the finger selected. */
	function pressStart(e: PointerEvent) {
		if (e.pointerType !== "touch" || !e.isPrimary || snapshot) return;
		cancelPress();
		const { clientX: x, clientY: y, pointerId: id } = e;
		const timer = window.setTimeout(() => {
			press = null;
			void enterSelect();
			// Select only once the finger lifts: the tap iOS synthesizes on release would collapse it.
			const lifted = (up: PointerEvent) => {
				if (up.pointerId !== id) return;
				removeEventListener("pointerup", lifted, true);
				removeEventListener("pointercancel", lifted, true);
				window.setTimeout(() => selectWordAt(x, y), LIFT_SETTLE_MS);
			};
			addEventListener("pointerup", lifted, true);
			addEventListener("pointercancel", lifted, true);
		}, LONG_PRESS_MS);
		press = { id, x, y, timer };
	}

	function pressMove(e: PointerEvent) {
		if (press?.id === e.pointerId && Math.hypot(e.clientX - press.x, e.clientY - press.y) > LONG_PRESS_SLOP_PX) {
			cancelPress();
		}
	}

	function cancelPress() {
		if (press) clearTimeout(press.timer);
		press = null;
	}

	async function create() {
		if (creating) return;
		creating = true;
		createError = null;
		try {
			const info = await api.terms.create({ cwd: win.props.cwd, ...size() });
			exitCode = null;
			pane.setProps({ termId: info.id, cwd: info.cwd });
		} catch (err) {
			createError = errorMessage(err);
		} finally {
			creating = false;
		}
	}

	async function refreshInfo(id: string) {
		try {
			const info = (await api.terms.list()).find((t) => t.id === id);
			if (!info || id !== win.props.termId) return;
			pane.status.clients = info.clients;
			pane.status.title = info.title || null;
			if (info.cwd && info.cwd !== win.props.cwd) pane.setProps({ cwd: info.cwd });
		} catch {
			// The connection banner already covers an unreachable gateway.
		}
	}

	// xterm lives for the whole pane; sessions come and go underneath it. untrack: nothing read while setting
	// it up (socket, modifiers) may recreate it.
	$effect(() =>
		untrack(() => {
			const t = new Terminal({
				fontFamily: getComputedStyle(host).getPropertyValue("--font-mono") || "monospace",
				fontSize: tokenPx("term-font-size"),
				theme: terminalTheme(),
				cursorBlink: true,
				scrollback: 5000,
				allowProposedApi: true,
			});
			const f = new FitAddon();
			t.loadAddon(f);
			t.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank", "noopener")));
			t.attachCustomKeyEventHandler((e) => !isShellChord(e));
			t.open(host);
			term = t;
			fit = f;
			refit();
			const data = t.onData(input);
			const ro = new ResizeObserver(() => refit());
			ro.observe(host);
			return () => {
				ro.disconnect();
				data.dispose();
				t.dispose();
				term = null;
				fit = null;
			};
		}),
	);

	// Theme follows the color scheme.
	$effect(() => {
		void viewport.dark;
		void viewport.layout;
		untrack(() => {
			if (!term) return;
			term.options.theme = terminalTheme();
			term.options.fontSize = tokenPx("term-font-size");
			refit();
		});
	});

	// One socket per session id; a missing id means the session still has to be created.
	$effect(() => {
		const id = termId;
		if (!id) {
			socket = null;
			untrack(() => void create());
			return;
		}
		replayed = false;
		exitCode = null;
		const s = new Socket<TermServerMsg, TermClientMsg>({
			path: `/ws/term/${encodeURIComponent(id)}`,
			onOpen: () => void refreshInfo(id),
			onMessage: (msg) => {
				if (!term) return;
				switch (msg.t) {
					case "replay":
						term.reset();
						term.write(msg.d);
						replayed = true;
						refit();
						sendResize();
						break;
					case "out":
						term.write(msg.d);
						break;
					case "resize":
						break;
					case "exit":
						exitCode = msg.code;
						s.exit();
						break;
				}
			},
			stillExists: async () => {
				const info = (await api.terms.list()).find((t) => t.id === id);
				if (info?.exited) exitCode = info.exitCode;
				return !!info && !info.exited;
			},
		});
		socket = s;
		const poll = window.setInterval(() => {
			if (pane.visible && document.visibilityState === "visible" && s.state === "live") void refreshInfo(id);
		}, CLIENTS_POLL_MS);
		return () => {
			clearInterval(poll);
			s.dispose();
		};
	});

	// "Connecting to terminal…" only once the wait is noticeable.
	$effect(() => {
		if (replayed || conn !== "connecting") {
			slow = false;
			return;
		}
		const t = window.setTimeout(() => (slow = true), SLOW_CONNECT_MS);
		return () => clearTimeout(t);
	});

	// The latest focused client sets the PTY size.
	$effect(() => {
		if (pane.focused && conn === "live") sendResize();
	});

	// Becoming visible again (workspace switch) needs a fit: hidden panes measure 0.
	$effect(() => {
		if (pane.visible) requestAnimationFrame(refit);
	});

	$effect(() => pane.onFocusRequest(() => term?.focus()));

	// Copy follows the native selection, but only one inside this pane's selectable layer.
	$effect(() => {
		if (!snapshot) return;
		const update = () => (hasSelection = ownedRange() !== null);
		document.addEventListener("selectionchange", update);
		return () => document.removeEventListener("selectionchange", update);
	});

	// A hidden pane (workspace switch) leaves select mode.
	$effect(() => {
		if (!pane.visible) untrack(exitSelect);
	});

	onDestroy(() => {
		pane.status.conn = null;
		cancelPress();
		clearTimeout(copiedTimer);
	});

	function restart() {
		pane.setProps({ termId: undefined });
	}

	const showKeys = $derived(viewport.coarse && pane.focused && conn === "live");
	const hasText = $derived(!!snapshot?.text.trim());
</script>

<div class="terminal">
	{#if createError}
		<EmptyState icon={Icons.Terminal} title="Couldn't start a terminal" text={createError}>
			{#snippet actions()}
				<Button variant="primary" onclick={create}>Retry</Button>
			{/snippet}
		</EmptyState>
	{:else if conn === "reconnecting"}
		<Banner tone="warning" icon={Icons.Offline} text="Reconnecting… (attempt {socket?.attempt ?? 1}). Input is paused.">
			{#snippet actions()}
				<Button size="sm" onclick={() => socket?.retryNow()}>Retry now</Button>
			{/snippet}
		</Banner>
	{:else if conn === "offline"}
		<Banner
			tone="neutral"
			icon={Icons.Offline}
			text="You're offline. The terminal keeps running on {session.me?.host ?? 'the server'} and reconnects when you're back."
		/>
	{:else if conn === "exited"}
		<Banner
			tone={exitCode !== null && exitCode !== 0 ? "danger" : "neutral"}
			text={exitCode === null ? "Process exited." : `Process exited (code ${exitCode}).`}
		>
			{#snippet actions()}
				<Button size="sm" variant="primary" onclick={restart}>Restart</Button>
				<Button size="sm" onclick={() => pane.close()}>Close window</Button>
			{/snippet}
		</Banner>
	{/if}
	<div class="screen" hidden={!!createError}>
		<div
			class="xterm-host"
			bind:this={host}
			onpointerdowncapture={pressStart}
			onpointermovecapture={pressMove}
			onpointerupcapture={cancelPress}
			onpointercancelcapture={cancelPress}
		></div>
		{#if !replayed && !createError && conn !== "exited"}
			<div class="loading">
				<Skeleton preset="lines" mono count={3} note={slow ? "Connecting to terminal…" : null} />
			</div>
		{/if}
		{#if snapshot}
			<div class="select-layer" bind:this={layer}>
				<pre
					bind:this={pre}
					aria-label="Terminal text"
					style:line-height={rowPx ? `${rowPx}px` : null}
					oncopy={nativeCopy}>{snapshot.text}</pre>
				{#if !hasText}
					<p class="select-empty">No terminal text to select yet.</p>
				{/if}
			</div>
		{/if}
	</div>
	{#if showKeys || snapshot}
		<ExtraKeys
			bind:ctrl
			bind:alt
			onkey={input}
			onhide={() => term?.blur()}
			selecting={!!snapshot}
			{hasSelection}
			{hasText}
			{copied}
			canPaste={conn === "live" && !pasting}
			onselect={enterSelect}
			onpaste={paste}
			oncopy={copySelection}
			onselectall={selectAll}
			ondone={exitSelect}
		/>
	{/if}
</div>

<svelte:window
	onkeydown={(e) => {
		if (snapshot && e.key === "Escape") {
			e.preventDefault();
			exitSelect();
		}
	}}
/>

<style>
	.terminal {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		background: var(--surface-1);
	}
	.screen {
		position: relative;
		flex: 1;
		min-height: 0;
		padding: var(--sp-1);
		&[hidden] {
			display: none;
		}
	}
	.xterm-host {
		width: 100%;
		height: 100%;
		/* Long-press enters select mode; keep iOS from opening its own callout on the terminal. */
		-webkit-touch-callout: none;
	}
	.select-layer {
		position: absolute;
		inset: 0;
		overflow: auto;
		overscroll-behavior: contain;
		background: var(--surface-1);
		color: var(--fg);
		box-shadow: inset 0 var(--edge-w) 0 var(--accent);
		user-select: text;
		-webkit-user-select: text;
		-webkit-touch-callout: default;
		cursor: text;
		pre {
			margin: 0;
			/* Same inset as .screen, so the rows sit where the terminal drew them. */
			padding: var(--sp-1);
			min-width: max-content;
			white-space: pre;
			font-family: var(--font-mono);
			font-size: var(--term-font-size);
			&::selection {
				background: var(--accent);
				color: var(--accent-fg);
			}
		}
	}
	.select-empty {
		position: absolute;
		inset: 0 0 auto;
		padding: var(--sp-3);
		color: var(--fg-muted);
		font-size: var(--text-sm);
		user-select: none;
		-webkit-user-select: none;
	}
	.loading {
		position: absolute;
		inset: 0;
		background: var(--surface-1);
	}
	.xterm-host :global(.xterm-viewport) {
		scrollbar-width: thin;
		/* xterm paints the viewport black behind the themed screen; it shows as a 1px frame on light themes. */
		background-color: var(--surface-1) !important;
	}
</style>
