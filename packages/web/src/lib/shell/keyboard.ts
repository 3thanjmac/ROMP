/**
 * Window manager shortcuts. Chords match on `e.code` + Alt (macOS Option produces characters, so `e.key` is
 * useless) and are handled in the capture phase, so panes (xterm, CodeMirror) never receive them. Every other
 * Alt chord passes through to the focused pane.
 */
import type { Dir } from "./layout";

export type ShellAction =
	| { type: "focus"; dir: Dir }
	| { type: "move"; dir: "left" | "right" }
	| { type: "resize"; dir: Dir }
	| { type: "cycleWidth" }
	| { type: "toggleFull" }
	| { type: "launcher" }
	| { type: "newTerminal" }
	| { type: "close" }
	| { type: "toggleMode" }
	| { type: "workspace"; n: number }
	| { type: "moveToWorkspace"; n: number }
	| { type: "cycleWorkspace"; delta: 1 | -1 }
	| { type: "shortcuts" };

const ARROWS: Record<string, Dir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

export function matchShortcut(e: KeyboardEvent): ShellAction | null {
	if (!e.altKey || e.metaKey) return null;
	const dir = ARROWS[e.code];
	// Ctrl+Alt is AltGr on many layouts: only the resize arrows use it.
	if (e.ctrlKey) return dir && !e.shiftKey ? { type: "resize", dir } : null;
	if (dir) {
		if (!e.shiftKey) return { type: "focus", dir };
		return dir === "left" || dir === "right" ? { type: "move", dir } : null;
	}
	const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
	if (digit) return e.shiftKey ? { type: "moveToWorkspace", n: Number(digit) } : { type: "workspace", n: Number(digit) };
	if (e.shiftKey) return e.code === "Slash" ? { type: "shortcuts" } : null;
	switch (e.code) {
		case "KeyR":
			return { type: "cycleWidth" };
		case "KeyM":
			return { type: "toggleFull" };
		case "KeyO":
			return { type: "launcher" };
		case "Enter":
		case "NumpadEnter":
			return { type: "newTerminal" };
		case "KeyW":
			return { type: "close" };
		case "KeyT":
			return { type: "toggleMode" };
		case "BracketLeft":
			return { type: "cycleWorkspace", delta: -1 };
		case "BracketRight":
			return { type: "cycleWorkspace", delta: 1 };
		default:
			return null;
	}
}

/** For xterm's attachCustomKeyEventHandler: true when the shell owns this chord. */
export function isShellChord(e: KeyboardEvent): boolean {
	return matchShortcut(e) !== null;
}

/**
 * Installs the capture-phase listener. `run` returns false to let a chord through (e.g. while a dialog that
 * does not use it is open).
 */
export function installShortcuts(run: (action: ShellAction) => boolean): () => void {
	const onKey = (e: KeyboardEvent) => {
		if (e.isComposing) return;
		const action = matchShortcut(e);
		if (!action || !run(action)) return;
		e.preventDefault();
		e.stopPropagation();
	};
	window.addEventListener("keydown", onKey, true);
	return () => window.removeEventListener("keydown", onKey, true);
}

/** The shortcut sheet, in display order. */
export const SHORTCUTS: ReadonlyArray<{ action: string; keys: string[] }> = [
	{ action: "Focus window left / right", keys: ["Alt ←", "Alt →"] },
	{ action: "Focus pane up / down (tile)", keys: ["Alt ↑", "Alt ↓"] },
	{ action: "Move window left / right", keys: ["Alt Shift ←", "Alt Shift →"] },
	{ action: "Cycle width preset", keys: ["Alt R"] },
	{ action: "Toggle full width", keys: ["Alt M"] },
	{ action: "Resize split (tile)", keys: ["Alt Ctrl ←→↑↓"] },
	{ action: "Launcher / command palette", keys: ["Alt O"] },
	{ action: "New terminal here", keys: ["Alt Enter"] },
	{ action: "Close window", keys: ["Alt W"] },
	{ action: "Toggle scroll / tile", keys: ["Alt T"] },
	{ action: "Switch to workspace 1–9", keys: ["Alt 1…9"] },
	{ action: "Move window to workspace 1–9", keys: ["Alt Shift 1…9"] },
	{ action: "Previous / next workspace", keys: ["Alt [", "Alt ]"] },
	{ action: "Keyboard shortcuts", keys: ["Alt Shift /"] },
];
