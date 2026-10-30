import fs from "node:fs";
import path from "node:path";
import { type RompEnv, shq } from "./env.ts";
import { RompError } from "./errors.ts";
import { git, run } from "./proc.ts";

interface MergirafSetup {
	driver: string;
	attributes: string;
}

let mergiraf: MergirafSetup | undefined;

async function mergirafSetup(): Promise<MergirafSetup> {
	if (mergiraf) return mergiraf;
	const binary = Bun.which("mergiraf");
	if (!binary) throw new RompError("bad_request", "mergiraf is not installed (or not on PATH)");
	const langs = await run([binary, "languages", "--gitattributes"], { cwd: "/" });
	if (langs.code !== 0) throw new RompError("git_failed", `mergiraf languages failed: ${langs.stderr.trim()}`);
	mergiraf = {
		driver: `${shq(binary)} merge --git %O %A %B -s %S -x %X -y %Y -p %P -l %L`,
		attributes: `# Managed by romp: syntax-aware merges via mergiraf.\n${langs.stdout.trim()}\n`,
	};
	return mergiraf;
}

/**
 * Route merges of mergiraf-supported files through mergiraf for the repository whose git
 * directory is `gitDir`. Uses `$GIT_DIR/info/attributes` and repo-local config only.
 */
export async function ensureMergeDriver(env: RompEnv, gitDir: string): Promise<void> {
	const { driver, attributes } = await mergirafSetup();
	const file = path.join(gitDir, "info", "attributes");
	let current: string | null = null;
	try {
		current = fs.readFileSync(file, "utf8");
	} catch {
		fs.mkdirSync(path.dirname(file), { recursive: true });
	}
	if (current !== attributes) fs.writeFileSync(file, attributes);
	const configured = await git(env, gitDir, ["config", "--local", "merge.mergiraf.driver"], { allowFail: true });
	if (configured.stdout.trim() !== driver) {
		await git(env, gitDir, ["config", "--local", "merge.mergiraf.name", "mergiraf"]);
		await git(env, gitDir, ["config", "--local", "merge.mergiraf.driver", driver]);
	}
}

const MARKER_LINE = /^(?:<{7,}|>{7,}|\|{7,})(?: |$)/m;

/** Files (relative to `dir`) that still contain conflict marker lines. */
export function filesWithMarkers(dir: string, files: readonly string[]): string[] {
	return files.filter((file) => {
		try {
			return MARKER_LINE.test(fs.readFileSync(path.join(dir, file), "utf8"));
		} catch {
			return false;
		}
	});
}

/** Paths with unmerged index entries. */
export async function unmergedFiles(env: RompEnv, cwd: string): Promise<string[]> {
	const out = await git(env, cwd, ["diff", "--name-only", "--diff-filter=U", "-z"]);
	return [...new Set(out.stdout.split("\0").filter(Boolean))];
}

export async function mergeInProgress(env: RompEnv, cwd: string): Promise<boolean> {
	const head = await git(env, cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowFail: true });
	return head.code === 0;
}
