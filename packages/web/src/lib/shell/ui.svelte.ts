/** Which frame-level overlays are open. One instance, shared by bars, shortcuts and panes. */
class FrameUi {
	/** Phone launcher sheet. */
	launcher = $state(false);
	/** Desktop / tablet command palette. */
	palette = $state(false);
	/** Phone overview sheet. */
	overview = $state(false);
	shortcuts = $state(false);
	/** Settings dialog. */
	settings = $state(false);
	/** Workspace id whose rename dialog is open. */
	renameWorkspace: string | null = $state(null);
	/** Visible part of the active scroll strip as fractions of its scroll width (top bar minimap bracket). */
	stripView = $state({ start: 0, end: 1 });
}

export const frameUi = new FrameUi();
