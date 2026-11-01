const SETTINGS_HASH = "#settings";

/** Which frame-level overlays are open. One instance, shared by bars, shortcuts and panes. */
class FrameUi {
	/** Phone launcher sheet. */
	launcher = $state(false);
	/** Desktop / tablet command palette. */
	palette = $state(false);
	/** Phone overview sheet. */
	overview = $state(false);
	shortcuts = $state(false);
	/** Settings page; mirrors `#settings` in the URL so browser Back closes it. Change it via open/closeSettings. */
	settings = $state(location.hash === SETTINGS_HASH);
	/** Workspace id whose rename dialog is open. */
	renameWorkspace: string | null = $state(null);
	/** Visible part of the active scroll strip as fractions of its scroll width (top bar minimap bracket). */
	stripView = $state({ start: 0, end: 1 });

	openSettings(): void {
		if (this.settings) return;
		history.pushState({ settings: true }, "", SETTINGS_HASH);
		this.settings = true;
	}

	closeSettings(): void {
		if (!this.settings) return;
		// Pop our own entry so Forward/Back stay balanced; a page loaded straight at #settings has none to pop.
		if (history.state?.settings) history.back();
		else history.replaceState(null, "", location.pathname + location.search);
		this.settings = false;
	}
}

export const frameUi = new FrameUi();

addEventListener("popstate", () => {
	frameUi.settings = location.hash === SETTINGS_HASH;
});
