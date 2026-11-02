import fs from "node:fs";
import path from "node:path";
import type { LandingState } from "@romp/protocol";
import { queueDir, type RompEnv, statusDir, statusFile } from "./env.ts";
import { ensureDir, readJsonFile, SHARED_DIR_MODE, writeFileAtomic } from "./fsutil.ts";

/** Lock the merge queue holds while landing or syncing `repo`. */
export const queueLock = (env: RompEnv, repo: string) => path.join(env.root, "work", `.${repo}.lock`);

/** Whether a landing job for `repo` waits in `incoming/` or `processing/`. */
export function landingsPending(env: RompEnv, repo: string): boolean {
	for (const state of ["incoming", "processing"] as const) {
		let names: string[];
		try {
			names = fs.readdirSync(queueDir(env, state));
		} catch {
			continue;
		}
		for (const name of names) {
			if (name.startsWith(".") || !name.endsWith(".json")) continue;
			try {
				if (readJsonFile<{ repo?: unknown }>(path.join(queueDir(env, state), name))?.repo === repo) return true;
			} catch {
				// corrupt jobs are quarantined by the queue
			}
		}
	}
	return false;
}

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
