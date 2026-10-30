/** What the phone launcher sheet, the overview and the desktop command palette can open. */
import type { AgentInfo, TermInfo, WindowKind } from "@romp/protocol";
import { api } from "../api";
import { Icons, type IconComponent } from "../icons";
import { session } from "./session.svelte";
import { shell, windowCwd } from "./shell.svelte";

export type LaunchKind = Exclude<WindowKind, "editor"> | "open-file";

export interface LaunchItem {
	kind: LaunchKind;
	label: string;
	icon: IconComponent;
}

export const LAUNCH_ITEMS: readonly LaunchItem[] = [
	{ kind: "terminal", label: "New terminal", icon: Icons.Terminal },
	{ kind: "agent", label: "New agent", icon: Icons.Agent },
	{ kind: "files", label: "Files", icon: Icons.Files },
	{ kind: "browser", label: "Browser", icon: Icons.Browser },
	{ kind: "tasks", label: "Tasks", icon: Icons.Tasks },
	{ kind: "open-file", label: "Open file…", icon: Icons.Editor },
];

/** Working directory for new terminals and agents: the focused window's directory, else home. */
export function launchCwd(): string {
	return windowCwd(shell.focusedWindow) ?? session.me?.home ?? "/";
}

/**
 * Opens a window of `kind` in `cwd` and focuses it. Tasks focuses the existing Tasks window when there is one.
 * `open-file` needs a path: pass it as `cwd`.
 */
export function launch(kind: LaunchKind, cwd: string, keyboard = false): void {
	switch (kind) {
		case "terminal":
			shell.open({ kind: "terminal", props: { cwd } }, { keyboard });
			return;
		case "agent":
			shell.open({ kind: "agent", props: { cwd } }, { keyboard });
			return;
		case "files":
			shell.open({ kind: "files", props: { path: cwd } }, { keyboard });
			return;
		case "browser":
			shell.open({ kind: "browser", props: { url: "" } }, { keyboard });
			return;
		case "tasks":
			if (!shell.focusWhere((w) => w.kind === "tasks", { keyboard })) {
				shell.open({ kind: "tasks", props: {} }, { keyboard });
			}
			return;
		case "open-file":
			shell.open({ kind: "editor", props: { path: cwd } }, { keyboard });
			return;
	}
}

export type RunningSession = { kind: "terminal"; info: TermInfo } | { kind: "agent"; info: AgentInfo };

/** Live terminal and agent sessions that no window shows. */
export async function runningSessions(): Promise<RunningSession[]> {
	const [terms, agents] = await Promise.all([api.terms.list(), api.agents.list()]);
	const shownTerms = new Set<string>();
	const shownAgents = new Set<string>();
	for (const ws of shell.state.workspaces) {
		for (const w of ws.windows) {
			if (w.kind === "terminal" && w.props.termId) shownTerms.add(w.props.termId);
			if (w.kind === "agent" && w.props.agentId) shownAgents.add(w.props.agentId);
		}
	}
	return [
		...terms.filter((t) => !t.exited && !shownTerms.has(t.id)).map((info) => ({ kind: "terminal" as const, info })),
		...agents.filter((a) => !a.exited && !shownAgents.has(a.id)).map((info) => ({ kind: "agent" as const, info })),
	].sort((a, b) => b.info.createdAt - a.info.createdAt);
}

export function attach(s: RunningSession): void {
	if (s.kind === "terminal") shell.open({ kind: "terminal", props: { termId: s.info.id, cwd: s.info.cwd } });
	else shell.open({ kind: "agent", props: { agentId: s.info.id, cwd: s.info.cwd } });
}

/** Focuses the window showing agent `agentId`, or opens one (to the right of `after` when given). */
export function openAgent(agentId: string, cwd: string, after?: string | null): void {
	if (shell.focusWhere((w) => w.kind === "agent" && w.props.agentId === agentId)) return;
	shell.open({ kind: "agent", props: { agentId, cwd } }, after === undefined ? {} : { after });
}
