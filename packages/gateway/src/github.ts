import type { RepoSuggestion } from "@romp/protocol";
import type { Subprocess } from "bun";
import { HttpError } from "./http.ts";
import { errorMessage } from "./util.ts";

/** Runs `gh` with `args`; resolves with its exit code and output (code 127 when it could not start). */
export type GhRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const CACHE_MS = 5 * 60_000;
const GH_TIMEOUT_MS = 60_000;
const MAX_RESULTS = 20;
const REPOS_PATH = "user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=pushed";
/** One JSON array per line; gh prints strings raw, so `@json` survives pagination without a merged document. */
const REPOS_JQ = '.[] | [.full_name, .clone_url, .description, .private, .pushed_at] | @json';

const runGh: GhRunner = async (args) => {
	let proc: Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(["gh", ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
		});
	} catch (err) {
		return { code: 127, stdout: "", stderr: errorMessage(err) };
	}
	const timer = setTimeout(() => proc.kill("SIGKILL"), GH_TIMEOUT_MS);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
};

/** The gateway user's GitHub repos via the gh CLI, cached for five minutes, filtered per query. */
export class RepoSearch {
	private cached: { at: number; repos: RepoSuggestion[] } | null = null;
	private loading: Promise<RepoSuggestion[]> | null = null;

	constructor(private readonly run: GhRunner = runGh) {}

	async search(query: string): Promise<RepoSuggestion[]> {
		const q = query.trim().toLowerCase();
		const repos = await this.repos();
		const rank = (r: RepoSuggestion) => {
			const full = r.fullName.toLowerCase();
			const name = full.slice(full.indexOf("/") + 1);
			return full.startsWith(q) || name.startsWith(q) ? 0 : 1;
		};
		return repos
			.filter((r) => r.fullName.toLowerCase().includes(q))
			.sort((a, b) => rank(a) - rank(b) || b.pushedAt - a.pushedAt)
			.slice(0, MAX_RESULTS);
	}

	private repos(): Promise<RepoSuggestion[]> {
		if (this.cached && Date.now() - this.cached.at < CACHE_MS) return Promise.resolve(this.cached.repos);
		this.loading ??= this.load().finally(() => {
			this.loading = null;
		});
		return this.loading;
	}

	private async load(): Promise<RepoSuggestion[]> {
		const { code, stdout, stderr } = await this.run(["api", "--paginate", REPOS_PATH, "--jq", REPOS_JQ]);
		if (code === 127) {
			throw new HttpError(503, "gh_unavailable", "The GitHub CLI (gh) is not installed on the VM. Install it, then run `gh auth login` there.");
		}
		if (code !== 0) {
			const detail = stderr.trim().split("\n").at(-1) ?? "";
			const signedOut = code === 4 || /auth login|not logged in|authenticat/i.test(stderr);
			throw new HttpError(
				signedOut ? 503 : 502,
				signedOut ? "gh_unavailable" : "gh_failed",
				signedOut ? "The GitHub CLI (gh) is not signed in. Run `gh auth login` on the VM." : `gh failed: ${detail}`,
			);
		}
		const repos: RepoSuggestion[] = [];
		for (const line of stdout.split("\n")) {
			if (!line.trim()) continue;
			const [fullName, url, description, isPrivate, pushedAt] = JSON.parse(line) as [string, string, string | null, boolean, string | null];
			repos.push({ fullName, url, description, private: isPrivate, pushedAt: pushedAt ? Date.parse(pushedAt) : 0 });
		}
		this.cached = { at: Date.now(), repos };
		return repos;
	}
}
