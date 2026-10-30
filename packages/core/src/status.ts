import type { LandingState } from "@romp/protocol";
import { type RompEnv, statusDir, statusFile } from "./env.ts";
import { ensureDir, readJsonFile, SHARED_DIR_MODE, writeFileAtomic } from "./fsutil.ts";

export function readLanding(env: RompEnv, repo: string, user: string, slug: string): LandingState | null {
	return readJsonFile<LandingState>(statusFile(env, repo, user, slug));
}

export type LandingUpdate = Pick<LandingState, "state" | "message"> &
	Partial<Pick<LandingState, "commit" | "prUrl" | "log">>;

/** Replace the task's landing state. `updatedAt` strictly increases so pollers see every write. */
export function writeLanding(env: RompEnv, repo: string, user: string, slug: string, update: LandingUpdate): LandingState {
	ensureDir(statusDir(env, repo), SHARED_DIR_MODE);
	const previous = readLanding(env, repo, user, slug);
	const state: LandingState = {
		commit: null,
		prUrl: null,
		log: null,
		...update,
		updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1),
	};
	writeFileAtomic(statusFile(env, repo, user, slug), `${JSON.stringify(state, null, "\t")}\n`);
	return state;
}
