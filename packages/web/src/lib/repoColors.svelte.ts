/** Each repo's color, shared by every window: Tasks windows keep it current, agent windows read it. */
import type { RepoColor, RepoInfo } from "@romp/protocol";
import { api } from "./api";

/** The CSS value for a repo color token. */
export const repoColorVar = (color: RepoColor) => `var(--repo-${color})`;

class RepoColors {
	#colors: Record<string, RepoColor> = $state({});
	/** Repos already looked up once when missing, so an unknown name doesn't refetch on every read. */
	#asked = new Set<string>();
	#loading = false;

	/** `repo`'s color, or null until known; a repo not seen yet loads the repo list once. */
	get(repo: string): RepoColor | null {
		const color = this.#colors[repo];
		if (!color && !this.#asked.has(repo)) {
			this.#asked.add(repo);
			void this.#load();
		}
		return color ?? null;
	}

	update(repos: readonly RepoInfo[]): void {
		for (const r of repos) if (this.#colors[r.name] !== r.color) this.#colors[r.name] = r.color;
	}

	async #load(): Promise<void> {
		if (this.#loading) return;
		this.#loading = true;
		try {
			this.update(await api.repos.list());
		} catch {
			// Agent windows just stay uncolored; the next Tasks load fills the colors in.
		} finally {
			this.#loading = false;
		}
	}
}

export const repoColors = new RepoColors();
