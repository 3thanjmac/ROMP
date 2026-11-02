/** Pure helpers for the tasks pane: attention groups, repo ordering and labels, and the GitHub search gate. */
import type { TaskInfo, TaskStatus } from "@romp/protocol";

export type TaskGroup = "attention" | "progress" | "shipping" | "landed";

export const GROUP_LABEL: Record<TaskGroup, string> = {
	attention: "Needs attention",
	progress: "In progress",
	shipping: "Shipping",
	landed: "Landed",
};

const GROUP_OF: Record<TaskStatus, TaskGroup> = {
	conflict: "attention",
	failed: "attention",
	active: "progress",
	queued: "shipping",
	landing: "shipping",
	landed: "landed",
};

const ORDER: TaskGroup[] = ["attention", "progress", "shipping", "landed"];

/** Non-empty groups in display order; newest task first inside each. */
export function groupTasks(tasks: readonly TaskInfo[]): Array<{ group: TaskGroup; tasks: TaskInfo[] }> {
	const sorted = tasks.toSorted((a, b) => b.createdAt - a.createdAt);
	return ORDER.map((group) => ({ group, tasks: sorted.filter((t) => GROUP_OF[t.status] === group) })).filter(
		(g) => g.tasks.length > 0,
	);
}

export const TITLE_MAX = 60;

/** `repos` with the one named `pinned` moved to the front; the rest keep their order. */
export function pinFirst<T extends { name: string }>(repos: readonly T[], pinned: string | null): T[] {
	const hit = pinned === null ? undefined : repos.find((r) => r.name === pinned);
	return hit ? [hit, ...repos.filter((r) => r !== hit)] : [...repos];
}

/** `host/owner/repo` from an https, ssh or scp-style remote; "hub only" without one. */
export function remoteLabel(remote: string | null): string {
	if (!remote) return "hub only";
	const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:](.+?)(?:\.git)?$/i.exec(remote);
	return m ? `${m[1]}/${m[2]}` : remote;
}

export const SEARCH_MIN_CHARS = 2;
const URL_LIKE = /^(?:http|git@|ssh:\/\/|\/|~|\.|file:)/i;

/** The text to search GitHub for, or null when it is too short or already looks like a URL or path. */
export function repoSearchQuery(text: string): string | null {
	const q = text.trim();
	if (q.length < SEARCH_MIN_CHARS || URL_LIKE.test(q)) return null;
	return q;
}

/** True while the queue is working on any task, which makes the pane poll faster. */
export function anyShipping(tasks: readonly TaskInfo[]): boolean {
	return tasks.some((t) => t.status === "queued" || t.status === "landing");
}
