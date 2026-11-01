<script lang="ts">
	import type { TermClientMsg, TermServerMsg } from "@romp/protocol";
	import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
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
	/** Release speed (px/ms) above which a scroll drag keeps gliding, and the speed where the glide stops. */
	const FLING_MIN_SPEED = 0.3;
	const FLING_STOP_SPEED = 0.02;
	/** Glide speed kept per 16 ms frame. */
	const FLING_DECAY = 0.95;
	/** A finger resting this long before lifting ends the drag without a glide. */
	const FLING_MAX_PAUSE_MS = 100;
	/** macOS copies and pastes with Cmd, which xterm already leaves to the browser; Ctrl+C/V stay control keys. */
	const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

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
	/** Touch drag that scrolls the terminal; `active` once it passed the slop. */
	let drag: { id: number; x: number; y0: number; lastY: number; lastT: number; speed: number; active: boolean } | null =
		null;
	/** Sub-row scroll distance (px) carried between moves. */
	let scrollRest = 0;
	let flingFrame = 0;
	/** The terminal had keyboard focus when select mode started; leaving it gives focus back. */
	let refocusAfterSelect = false;
	/** The replayed scrollback is being parsed: its old OSC 52 copies must not overwrite the clipboard again. */
	let replaying = false;

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

	/** Height of one terminal row in CSS px; 0 before the first render. */
	function rowHeight(): number {
		const screen = term?.element?.querySelector(".xterm-screen");
		return screen && term?.rows ? screen.clientHeight / term.rows : 0;
	}

	async function enterSelect() {
		if (!term || snapshot) return;
		const buffer = term.buffer.active;
		rowPx = rowHeight();
		snapshot = snapshotBuffer(buffer);
		refocusAfterSelect = !!term.textarea && document.activeElement === term.textarea;
		term.blur();
		await tick();
		if (layer) layer.scrollTop = buffer.viewportY * rowPx;
	}

	/** `refocus`: give the keyboard back if select mode took it (runs inside the tap, as iOS requires). */
	function exitSelect(refocus = true) {
		if (!snapshot) return;
		if (ownedRange()) getSelection()?.removeAllRanges();
		snapshot = null;
		hasSelection = false;
		copied = false;
		clearTimeout(copiedTimer);
		if (refocus && refocusAfterSelect) term?.focus();
		refocusAfterSelect = false;
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

	/**
	 * Scrolls by `lines` (positive: towards the bottom). The normal buffer scrolls its scrollback. Full-screen apps
	 * (alternate buffer) and apps that read the mouse get one wheel event per line, which xterm turns into an
	 * arrow key or a mouse wheel report, the same as a mouse wheel over the terminal.
	 */
	function scrollRows(lines: number, x: number, y: number) {
		if (!term || lines === 0) return;
		if (term.buffer.active.type === "normal" && term.modes.mouseTrackingMode === "none") {
			term.scrollLines(lines);
			return;
		}
		for (let i = 0; i < Math.abs(lines); i++) {
			term.element?.dispatchEvent(
				new WheelEvent("wheel", {
					deltaY: Math.sign(lines),
					deltaMode: WheelEvent.DOM_DELTA_LINE,
					clientX: x,
					clientY: y,
					bubbles: true,
					cancelable: true,
				}),
			);
		}
	}

	/** Content follows the finger: dragging down by `px` reveals earlier rows. */
	function scrollByDrag(px: number, x: number, y: number) {
		const row = rowHeight();
		if (!row) return;
		scrollRest += px;
		const rows = Math.trunc(scrollRest / row);
		if (rows === 0) return;
		scrollRest -= rows * row;
		scrollRows(-rows, x, y);
	}

	function stopFling() {
		cancelAnimationFrame(flingFrame);
		flingFrame = 0;
	}

	function dragStart(e: PointerEvent) {
		stopFling();
		if (e.pointerType !== "touch" || !e.isPrimary || snapshot) return;
		drag = { id: e.pointerId, x: e.clientX, y0: e.clientY, lastY: e.clientY, lastT: e.timeStamp, speed: 0, active: false };
		scrollRest = 0;
	}

	function dragMove(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.id) return;
		const dy = e.clientY - drag.lastY;
		const dt = e.timeStamp - drag.lastT;
		drag.lastY = e.clientY;
		drag.lastT = e.timeStamp;
		drag.x = e.clientX;
		if (dt > 0) drag.speed = dy / dt;
		if (!drag.active) {
			if (Math.abs(e.clientY - drag.y0) <= LONG_PRESS_SLOP_PX) return;
			drag.active = true;
		}
		scrollByDrag(dy, e.clientX, e.clientY);
	}

	/** A quick release keeps the scrollback gliding; full-screen apps get no glide (it would be a burst of keys). */
	function dragEnd(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.id) return;
		const { active, x, lastY, lastT } = drag;
		let speed = drag.speed;
		drag = null;
		const glide =
			e.type === "pointerup" &&
			active &&
			Math.abs(speed) > FLING_MIN_SPEED &&
			e.timeStamp - lastT < FLING_MAX_PAUSE_MS &&
			term?.buffer.active.type === "normal" &&
			term.modes.mouseTrackingMode === "none";
		if (!glide) return;
		let last = performance.now();
		const step = (now: number) => {
			const dt = now - last;
			last = now;
			scrollByDrag(speed * dt, x, lastY);
			speed *= FLING_DECAY ** (dt / 16);
			flingFrame = Math.abs(speed) > FLING_STOP_SPEED ? requestAnimationFrame(step) : 0;
		};
		flingFrame = requestAnimationFrame(step);
	}

	/**
	 * Soft-keyboard Backspace. Held on iOS, it repeats as a stream of `beforeinput` deletes rather than keydowns,
	 * and the repeat stops if the keydown is cancelled, which xterm does for a Backspace it handles. So on touch
	 * devices a plain Backspace keydown is left alone (`skipBackspace`) and every backward delete the textarea
	 * would apply is sent as DEL instead, keeping the textarea unchanged so xterm's own input diffing sends
	 * nothing for it. IME composition stays with xterm.
	 */
	const softDelete = {
		/** Set by a skipped keydown until its beforeinput arrives; if none does, the keydown sends DEL itself. */
		pending: false,
		skip(e: KeyboardEvent): boolean {
			if (!viewport.coarse || e.type !== "keydown" || e.key !== "Backspace" || e.isComposing) return false;
			if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
			softDelete.pending = true;
			window.setTimeout(() => {
				if (softDelete.pending) input("\x7f");
				softDelete.pending = false;
			});
			return true;
		},
		beforeinput(e: InputEvent) {
			if (!viewport.coarse || e.isComposing || !/^delete.*Backward$/.test(e.inputType)) return;
			e.preventDefault();
			softDelete.pending = false;
			input("\x7f");
		},
	};

	/**
	 * Ctrl+V pastes, and Ctrl+C copies while xterm has a selection, like Windows Terminal (Ctrl+Shift+V already
	 * pastes). Returning true leaves the keydown to the browser, which fires the native paste/copy event that xterm
	 * turns into a bracketed paste or a copy of its selection, instead of sending ^V/^C to the program.
	 */
	function nativeClipboardKey(e: KeyboardEvent): boolean {
		if (IS_MAC || e.type !== "keydown" || !e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
		const key = e.key.toLowerCase();
		if (key === "v") return true;
		if (key !== "c" || !term?.hasSelection()) return false;
		// After the copy event: the next Ctrl+C interrupts again.
		window.setTimeout(() => term?.clearSelection());
		return true;
	}

	/**
	 * OSC 52 copies from programs (omp, tmux, vim) go to the browser clipboard. Reads are refused: they would let
	 * anything running in the terminal, or a file printed to it, take the clipboard.
	 */
	const osc52: IClipboardProvider = {
		readText: () => "",
		async writeText(selection, text) {
			if (replaying || selection !== "c" || !text) return;
			try {
				await navigator.clipboard.writeText(text);
			} catch {
				// Unfocused tab or no permission: nothing to do, the program has no way to hear about it.
			}
		},
	};

	async function create() {
		if (creating) return;
		creating = true;
		createError = null;
		try {
			const info = await api.terms.create({
				cwd: win.props.cwd,
				command: win.props.command,
				title: win.props.command && win.title ? win.title : undefined,
				...size(),
			});
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
			t.loadAddon(new ClipboardAddon(undefined, osc52));
			t.attachCustomKeyEventHandler((e) => !isShellChord(e) && !softDelete.skip(e) && !nativeClipboardKey(e));
			t.open(host);
			term = t;
			fit = f;
			refit();
			const data = t.onData(input);
			const textarea = t.textarea;
			textarea?.addEventListener("beforeinput", softDelete.beforeinput);
			const ro = new ResizeObserver(() => refit());
			ro.observe(host);
			return () => {
				ro.disconnect();
				data.dispose();
				textarea?.removeEventListener("beforeinput", softDelete.beforeinput);
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
						replaying = true;
						term.write(msg.d, () => (replaying = false));
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
		if (!pane.visible) untrack(() => exitSelect(false));
	});

	onDestroy(() => {
		pane.status.conn = null;
		cancelPress();
		stopFling();
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
			onpointerdowncapture={(e) => (pressStart(e), dragStart(e))}
			onpointermovecapture={(e) => (pressMove(e), dragMove(e))}
			onpointerupcapture={(e) => (cancelPress(), dragEnd(e))}
			onpointercancelcapture={(e) => (cancelPress(), dragEnd(e))}
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
			ondone={() => exitSelect()}
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
		/* Vertical drags scroll the terminal (dragMove); sideways ones still swipe between windows. */
		touch-action: pan-x;
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
