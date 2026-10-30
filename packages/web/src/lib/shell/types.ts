import type { WindowKind, WindowState } from "@romp/protocol";

/** The WindowState of one kind, e.g. `WindowOf<"agent">`. */
export type WindowOf<K extends WindowKind> = Extract<WindowState, { kind: K }>;

/** What callers pass to open a window; the shell assigns id, width and title defaults. */
export type NewWindow = {
	[K in WindowKind]: { kind: K; props: WindowOf<K>["props"]; title?: string; width?: number };
}[WindowKind];

/** Editor save state shown by SaveStatus in the title bar. */
export type SaveState = "saved" | "saving" | "unsaved" | "offline" | "failed" | "conflict";
