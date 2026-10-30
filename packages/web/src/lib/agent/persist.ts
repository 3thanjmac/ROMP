/** Per-window composer state kept in localStorage so a reload or a dropped connection never loses typed text. */

export type BusySend = "steer" | "follow_up";

const PREFIX = "romp.agent.";

function get(key: string): string | null {
	try {
		return localStorage.getItem(PREFIX + key);
	} catch {
		return null;
	}
}

function set(key: string, value: string | null): void {
	try {
		if (value === null) localStorage.removeItem(PREFIX + key);
		else localStorage.setItem(PREFIX + key, value);
	} catch {
		// Storage full or disabled: the text still lives in the composer.
	}
}

export function loadDraft(windowId: string): string {
	return get(`draft.${windowId}`) ?? "";
}

export function saveDraft(windowId: string, text: string): void {
	set(`draft.${windowId}`, text === "" ? null : text);
}

/** Whether a message typed while the agent works steers it now (default) or waits for the turn to end. */
export function loadBusySend(windowId: string): BusySend {
	return get(`busy-send.${windowId}`) === "follow_up" ? "follow_up" : "steer";
}

export function saveBusySend(windowId: string, mode: BusySend): void {
	set(`busy-send.${windowId}`, mode === "steer" ? null : mode);
}
