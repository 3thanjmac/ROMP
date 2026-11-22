/** Per-device display preferences, kept in localStorage. */

const COLLAPSE_THINKING_KEY = "romp:collapseThinking";

function load(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

class Prefs {
	/** Collapse agent thinking blocks behind their "Thought for …" button. Off: thinking is shown expanded. */
	#collapseThinking = $state(load(COLLAPSE_THINKING_KEY) === "1");

	get collapseThinking(): boolean {
		return this.#collapseThinking;
	}

	set collapseThinking(value: boolean) {
		this.#collapseThinking = value;
		try {
			localStorage.setItem(COLLAPSE_THINKING_KEY, value ? "1" : "0");
		} catch {
			// Storage full or disabled: the choice holds until reload.
		}
	}
}

export const prefs = new Prefs();
