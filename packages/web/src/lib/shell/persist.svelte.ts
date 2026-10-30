/**
 * ShellState persistence: localStorage paints the last layout instantly, the gateway (`/api/state`) is the
 * source of truth across devices (last write wins). Changes are PUT 500ms after the last edit; the server copy
 * is re-read when the tab becomes visible again, unless a local edit is still waiting to be saved.
 */
import type { ShellState } from "@romp/protocol";
import { api } from "../api";
import { normalizeState } from "./normalize";
import { seedState, shell } from "./shell.svelte";

const STORAGE_KEY = "romp.shell-state";
const SAVE_DELAY_MS = 500;

class Persistence {
	/** The first load (local or remote) has finished; the frame can render. */
	ready = $state(false);
}

export const persistence = new Persistence();

/** Serialized form of the last state written to (or read from) the gateway. */
let lastSynced = "";
let timer: number | undefined;
let dirty = false;

function readLocal(): ShellState | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? normalizeState(JSON.parse(raw)) : null;
	} catch {
		return null;
	}
}

function writeLocal(json: string): void {
	try {
		localStorage.setItem(STORAGE_KEY, json);
	} catch {
		// Storage full or disabled: the gateway copy still persists.
	}
}

function adopt(state: ShellState): void {
	shell.state = state;
	lastSynced = JSON.stringify(state);
	writeLocal(lastSynced);
}

async function pullRemote(): Promise<void> {
	const remote = await api.state.get();
	if (dirty) return;
	if (remote === null) {
		// Nothing saved yet: keep whatever is on screen (local copy or the seed) and save it.
		dirty = true;
		await flush();
		return;
	}
	const normalized = normalizeState(remote);
	if (!normalized) return;
	if (JSON.stringify(normalized) !== JSON.stringify(shell.state)) adopt(normalized);
	else lastSynced = JSON.stringify(normalized);
}

async function flush(): Promise<void> {
	clearTimeout(timer);
	const snapshot = $state.snapshot(shell.state) as ShellState;
	const json = JSON.stringify(snapshot);
	if (json === lastSynced) {
		dirty = false;
		return;
	}
	try {
		await api.state.put(snapshot);
		lastSynced = json;
		if (JSON.stringify(shell.state) === json) dirty = false;
	} catch {
		// Offline or gateway down: localStorage holds the edit; retry on the next change or visibility.
	}
}

/** Loads the layout, then keeps it saved. Call once from the app root. */
export async function initPersistence(): Promise<void> {
	shell.state = readLocal() ?? seedState();
	try {
		await pullRemote();
	} catch {
		// Offline: run from the local copy.
	}
	persistence.ready = true;

	$effect.root(() => {
		$effect(() => {
			const json = JSON.stringify(shell.state);
			writeLocal(json);
			if (json === lastSynced) return;
			dirty = true;
			clearTimeout(timer);
			timer = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
		});
	});

	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") {
			if (dirty) void flush();
			return;
		}
		if (dirty) void flush();
		else void pullRemote().catch(() => {});
	});
}
