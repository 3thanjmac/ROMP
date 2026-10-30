/** Repos, tasks and agents for one Tasks pane, plus the actions its rows run. */
import type { AgentInfo, LandMode, RepoInfo, TaskInfo } from "@romp/protocol";
import { api, errorMessage } from "../../lib/api";
import type { PaneContext } from "../../lib/shell/pane.svelte";
import { shell } from "../../lib/shell/shell.svelte";
import { toast } from "../../lib/ui/toast.svelte";
import { anyShipping } from "./group";

const FAST_POLL_MS = 3000;
const SLOW_POLL_MS = 15_000;
const SHIP_HOLD_MS = 5000;

export const taskKey = (t: Pick<TaskInfo, "repo" | "slug">) => `${t.repo}/${t.slug}`;

export class TasksData {
	repos: RepoInfo[] | null = $state(null);
	tasks: TaskInfo[] = $state([]);
	agents: AgentInfo[] = $state([]);
	error: string | null = $state(null);
	/** Tasks whose ship is held for Undo or in flight: shown as Queued until the server says otherwise. */
	shipping: Record<string, true> = $state({});

	#pane: PaneContext<"tasks">;
	#timer: number | undefined;
	#disposed = false;

	constructor(pane: PaneContext<"tasks">) {
		this.#pane = pane;
	}

	async load(): Promise<void> {
		try {
			const [repos, tasks, agents] = await Promise.all([api.repos.list(), api.tasks.list(), api.agents.list()]);
			this.repos = repos;
			this.tasks = tasks;
			this.agents = agents;
			this.error = null;
		} catch (err) {
			if (this.repos === null) this.error = errorMessage(err);
		}
	}

	/** Polls every 3s while the queue is busy and the tab is visible, else every 15s. */
	start(): () => void {
		const tick = async () => {
			if (document.visibilityState === "visible" && this.#pane.visible) await this.load();
			if (this.#disposed) return;
			this.#timer = window.setTimeout(tick, anyShipping(this.tasks) ? FAST_POLL_MS : SLOW_POLL_MS);
		};
		const onVisible = () => {
			if (document.visibilityState !== "visible") return;
			clearTimeout(this.#timer);
			void tick();
		};
		void this.load().then(() => {
			if (!this.#disposed) this.#timer = window.setTimeout(tick, anyShipping(this.tasks) ? FAST_POLL_MS : SLOW_POLL_MS);
		});
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			this.#disposed = true;
			clearTimeout(this.#timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}

	tasksOf(repo: string): TaskInfo[] {
		return this.tasks
			.filter((t) => t.repo === repo)
			.map((t) =>
				this.shipping[taskKey(t)] && (t.status === "active" || t.status === "failed")
					? { ...t, status: "queued" as const, landing: null }
					: t,
			);
	}

	agentFor(task: TaskInfo): AgentInfo | null {
		return this.agents.find((a) => !a.exited && a.task?.repo === task.repo && a.task.slug === task.slug) ?? null;
	}

	/** Focuses the task's agent window, attaching to its running session or starting a new one. */
	async openAgent(task: TaskInfo): Promise<void> {
		try {
			const agent = this.agentFor(task) ?? (await api.agents.create({ cwd: task.path, title: task.title }));
			if (!shell.focusWhere((w) => w.kind === "agent" && w.props.agentId === agent.id)) {
				this.#pane.open({ kind: "agent", props: { agentId: agent.id, cwd: agent.cwd } });
			}
			void this.load();
		} catch (err) {
			toast({ message: errorMessage(err), tone: "danger" });
		}
	}

	openTerminal(task: TaskInfo): void {
		this.#pane.open({ kind: "terminal", props: { cwd: task.path } });
	}

	openFiles(task: TaskInfo): void {
		this.#pane.open({ kind: "files", props: { path: task.path } });
	}

	/**
	 * Shows the task as Queued at once and holds the POST for 5s behind an Undo toast: a push to the integration
	 * branch can't be taken back and the API has no cancel.
	 */
	ship(task: TaskInfo, branch: string): void {
		const key = taskKey(task);
		if (this.shipping[key]) return;
		this.shipping[key] = true;
		toast({
			message: `Shipping ${task.title} to ${branch}`,
			action: { label: "Undo", run: () => {} },
			duration: SHIP_HOLD_MS,
			onclose: (reason) => {
				if (reason === "action") {
					delete this.shipping[key];
					return;
				}
				void this.#postShip(task, key);
			},
		});
	}

	async #postShip(task: TaskInfo, key: string): Promise<void> {
		try {
			const updated = await api.tasks.ship(task.repo, task.slug);
			this.tasks = this.tasks.map((t) => (taskKey(t) === key ? updated : t));
		} catch (err) {
			toast({ message: errorMessage(err), tone: "danger" });
		} finally {
			delete this.shipping[key];
			void this.load();
		}
	}

	/** Irreversible: waits for the server, no optimistic removal. */
	async remove(task: TaskInfo): Promise<void> {
		await api.tasks.remove(task.repo, task.slug);
		this.tasks = this.tasks.filter((t) => taskKey(t) !== taskKey(task));
		void this.load();
	}

	/** Optimistic land-mode change; rolls back and toasts on failure. Resolves true when saved. */
	async setLand(repo: RepoInfo, land: LandMode): Promise<boolean> {
		const before = repo.land;
		repo.land = land;
		try {
			const updated = await api.repos.settings(repo.name, { land });
			this.repos = this.repos?.map((r) => (r.name === updated.name ? updated : r)) ?? null;
			return true;
		} catch (err) {
			repo.land = before;
			toast({ message: errorMessage(err), tone: "danger" });
			return false;
		}
	}
}
