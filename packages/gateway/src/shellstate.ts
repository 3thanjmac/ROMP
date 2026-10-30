import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { badRequest, notFound } from "./http.ts";
import { errnoCode, writeFileAtomic } from "./util.ts";

export const MAX_STATE_BYTES = 1024 * 1024;

/** The web shell's layout (`ShellState`), stored verbatim at `<state_dir>/shell.json`. */
export class ShellStateStore {
	private readonly file: string;

	constructor(private readonly stateDir: string) {
		this.file = join(stateDir, "shell.json");
	}

	async get(): Promise<unknown> {
		try {
			return JSON.parse(await readFile(this.file, "utf8"));
		} catch (err) {
			if (errnoCode(err) === "ENOENT") throw notFound("No saved shell state");
			throw err;
		}
	}

	async put(state: Record<string, unknown>): Promise<void> {
		if (state.version !== 1) throw badRequest(`Unsupported shell state version ${JSON.stringify(state.version)}`);
		if (typeof state.activeWorkspaceId !== "string" || !Array.isArray(state.workspaces)) {
			throw badRequest("Shell state needs activeWorkspaceId and workspaces");
		}
		await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
		await writeFileAtomic(this.file, JSON.stringify(state), 0o600);
	}
}
