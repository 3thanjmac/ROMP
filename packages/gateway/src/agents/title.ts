import { autoTitle } from "@romp/protocol";
import type { Subprocess } from "bun";
import { errorMessage } from "../util.ts";

/** A short title for the task `prompt` describes, or null when none could be made. `cwd` is the task's worktree. */
export type TitleGenerator = (cwd: string, prompt: string) => Promise<string | null>;

const TIMEOUT_MS = 45_000;
/** Enough of the prompt to name the task; keeps the argv well under the kernel's per-argument limit. */
const PROMPT_CHARS = 4000;
const INSTRUCTION =
	"Write a 3-5 word title for the coding task below. Reply with only the title: no quotes, no markdown, no trailing punctuation.";

/**
 * Asks OMP in print mode (its `tiny` model role, no tools or context) for a title. RPC sessions cannot title
 * themselves: OMP's RPC mode disables its own titling.
 */
export function ompTitleGenerator(omp: string, timeoutMs = TIMEOUT_MS): TitleGenerator {
	return async (cwd, prompt) => {
		const argv = [
			omp,
			"-p",
			"--no-session",
			"--model",
			"@tiny",
			"--no-tools",
			"--no-skills",
			"--no-rules",
			"--no-context-files",
			"--no-extensions",
			"--no-lsp",
			"--thinking",
			"off",
			`${INSTRUCTION}\n\nTask:\n${prompt.slice(0, PROMPT_CHARS)}`,
		];
		let proc: Subprocess<"ignore", "pipe", "pipe">;
		try {
			proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		} catch (err) {
			console.warn(`title: could not run ${omp}: ${errorMessage(err)}`);
			return null;
		}
		// Race rather than wait for EOF: a child OMP left behind could hold the pipes open past the kill.
		const expired = Promise.withResolvers<null>();
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			expired.resolve(null);
		}, timeoutMs);
		try {
			const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
			const result = await Promise.race([output, expired.promise]);
			if (!result) {
				console.warn(`title: omp gave no title within ${timeoutMs} ms`);
				return null;
			}
			const [stdout, stderr, code] = result;
			if (code !== 0) {
				console.warn(`title: omp exited with ${code}: ${stderr.trim().slice(-300)}`);
				return null;
			}
			return cleanTitle(stdout) || null;
		} finally {
			clearTimeout(timer);
		}
	};
}

/** First non-empty line of a model reply without markdown, quotes or trailing punctuation, capped by `autoTitle`. */
export function cleanTitle(reply: string): string {
	const line = reply.split("\n").find((l) => l.trim()) ?? "";
	const bare = line
		.replace(/[*`]/g, "")
		.trim()
		.replace(/^(?:#+\s*|-\s+|title:\s*)+/i, "")
		.replace(/^["'“”‘’]+/, "")
		.replace(/["'“”‘’.!?:;,\s]+$/, "");
	return autoTitle(bare);
}
