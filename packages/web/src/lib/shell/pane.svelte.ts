/**
 * The contract between the window manager and the panes it hosts.
 * A pane component receives `{ win, pane }`: `win` is its live WindowState (read reactively, never mutate it;
 * use `pane.setProps`), `pane` is the PaneContext below.
 */
import type { WindowKind } from "@romp/protocol";
import { tick } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import type { ConnState } from "../conn/socket.svelte";
import type { NewWindow, SaveState, WindowOf } from "./types";

/** What a pane reports for the title bar, Overview, launcher and palette. Assign fields directly. */
export class PaneStatus {
	/** Terminal/agent connection → ConnDot. */
	conn: ConnState | null = $state(null);
	exitCode: number | null = $state(null);
	/** Attached clients (TermInfo/AgentInfo.clients) → ClientCount when > 1. */
	clients = $state(0);
	/** Agent turn in flight → "Working" spinner. */
	busy = $state(false);
	/** Agent has unanswered questions → "Needs input" chip and the Overview dot. */
	needsInput = $state(false);
	/** Pane-provided title (AgentInfo.title, terminal title). A user rename (WindowState.title) wins. */
	title: string | null = $state(null);
	/** Secondary line in Overview and launcher rows (cwd or path). */
	subtitle: string | null = $state(null);
	/** Editor save state → SaveStatus; `retrySave` runs when the user clicks a failed save. */
	save: SaveState | null = $state(null);
	retrySave: (() => void) | null = $state(null);
}

export interface PaneContext<K extends WindowKind = WindowKind> {
	readonly id: string;
	/** This window has WM focus and its workspace is the active one. */
	readonly focused: boolean;
	/** This window's workspace is the active one (its frame is displayed). */
	readonly visible: boolean;
	readonly status: PaneStatus;
	/** Patches this window's persisted props (e.g. `agentId` once a session exists). */
	setProps(patch: Partial<WindowOf<K>["props"]>): void;
	/**
	 * Registers what keyboard-initiated WM focus should focus inside the pane (xterm, CodeMirror, composer).
	 * Call inside an $effect and return the unregister function from it.
	 */
	onFocusRequest(fn: () => void): () => void;
	/** Opens a window to the right of this one and focuses it; returns the new window id. */
	open(spec: NewWindow): string;
	/** Closes this window with an Undo toast; a terminal or agent session it shows ends unless undone. */
	close(): void;
}

/** Live statuses by window id (created by WindowFrame, removed when the frame unmounts). */
export const paneStatuses = new SvelteMap<string, PaneStatus>();

const focusHandlers = new Map<string, () => void>();

export function registerFocusHandler(id: string, fn: () => void): () => void {
	focusHandlers.set(id, fn);
	return () => {
		if (focusHandlers.get(id) === fn) focusHandlers.delete(id);
	};
}
/**
 * Moves DOM focus into a window after the next render (keyboard-initiated focus changes only). Panes without a
 * focus target get the frame itself, so keys stop reaching the previously focused pane.
 */
export function requestPaneFocus(id: string): void {
	void tick().then(() => {
		const handler = focusHandlers.get(id);
		if (handler) handler();
		else document.querySelector<HTMLElement>(`[data-window="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
	});
}
