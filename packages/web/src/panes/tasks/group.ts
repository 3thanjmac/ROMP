/** Pure helpers for the tasks pane: attention groups and the title suggested from a prompt. */
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

/** First non-empty line of the prompt, cut at a word boundary to at most 60 characters. */
export function titleFromPrompt(prompt: string): string {
	const line = prompt.split("\n").find((l) => l.trim())?.trim() ?? "";
	if (line.length <= TITLE_MAX) return line;
	const cut = line.slice(0, TITLE_MAX);
	const space = cut.lastIndexOf(" ");
	return (space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd();
}

/** True while the queue is working on any task, which makes the pane poll faster. */
export function anyShipping(tasks: readonly TaskInfo[]): boolean {
	return tasks.some((t) => t.status === "queued" || t.status === "landing");
}
