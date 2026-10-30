/** Terminal input encoding for the touch extra-keys row and its sticky Ctrl / Alt modifiers. */

export type ModState = "off" | "latched" | "locked";

/** Next state after a tap; `doubleTap` is a second tap within the double-tap window. */
export function nextModState(current: ModState, doubleTap: boolean): ModState {
	if (current === "off") return "latched";
	if (current === "latched" && doubleTap) return "locked";
	return "off";
}

export const KEY_SEQ = {
	esc: "\x1b",
	tab: "\t",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
} as const;

const ARROW = /^\x1b\[([ABCD])$/;

/**
 * Applies Ctrl / Alt to one chunk of input. Ctrl maps a single letter (or @[\]^_ and space) to its control
 * code and turns arrows into xterm's modified form (`ESC [1;5A`); Alt prefixes ESC (Meta sends Escape).
 */
export function applyModifiers(data: string, ctrl: boolean, alt: boolean): string {
	if (!ctrl && !alt) return data;
	const arrow = ARROW.exec(data);
	if (arrow) {
		const mod = 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0);
		return `\x1b[1;${mod}${arrow[1]}`;
	}
	let out = data;
	if (ctrl && data.length === 1) {
		const code = data.toUpperCase().charCodeAt(0);
		if (data === " ") out = "\x00";
		else if (code >= 0x40 && code <= 0x5f) out = String.fromCharCode(code & 0x1f);
		else if (data === "?") out = "\x7f";
	}
	return alt ? `\x1b${out}` : out;
}
