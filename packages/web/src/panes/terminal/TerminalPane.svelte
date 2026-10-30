<script lang="ts">
	import type { TermClientMsg, TermServerMsg } from "@romp/protocol";
	import { FitAddon } from "@xterm/addon-fit";
	import { WebLinksAddon } from "@xterm/addon-web-links";
	import { Terminal } from "@xterm/xterm";
	import { onDestroy, untrack } from "svelte";
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
	import ExtraKeys from "./ExtraKeys.svelte";
	import { applyModifiers, type ModState } from "./keys";

	let { win, pane }: { win: WindowOf<"terminal">; pane: PaneContext<"terminal"> } = $props();

	const CLIENTS_POLL_MS = 15_000;
	const SLOW_CONNECT_MS = 1000;

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

	onDestroy(() => {
		pane.status.conn = null;
	});

	function restart() {
		pane.setProps({ termId: undefined });
	}

	const showKeys = $derived(viewport.coarse && pane.focused && conn === "live");
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
		<div class="xterm-host" bind:this={host}></div>
		{#if !replayed && !createError && conn !== "exited"}
			<div class="loading">
				<Skeleton preset="lines" mono count={3} note={slow ? "Connecting to terminal…" : null} />
			</div>
		{/if}
	</div>
	{#if showKeys}
		<ExtraKeys bind:ctrl bind:alt onkey={input} onhide={() => term?.blur()} />
	{/if}
</div>

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
