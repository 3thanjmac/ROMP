/**
 * Detects git commands that would change repository state, so the OMP extension can block
 * them inside romp task worktrees (romp owns commits, merges and pushes there).
 *
 * The shell scan is a guardrail for a cooperative agent, not a sandbox: it understands
 * quoting, `;`/`&&`/`|` chains, `$(...)`, backticks, `bash -c` and common wrappers.
 */

/** Subcommands that only read (or write outside the repository). */
const READ_ONLY: Record<string, true> = {
	annotate: true,
	archive: true,
	blame: true,
	bugreport: true,
	"cat-file": true,
	cherry: true,
	"check-attr": true,
	"check-ignore": true,
	"check-mailmap": true,
	"check-ref-format": true,
	clone: true,
	column: true,
	"count-objects": true,
	describe: true,
	diff: true,
	"diff-files": true,
	"diff-index": true,
	"diff-tree": true,
	difftool: true,
	"for-each-ref": true,
	"format-patch": true,
	fsck: true,
	"get-tar-commit-id": true,
	grep: true,
	help: true,
	log: true,
	"ls-files": true,
	"ls-remote": true,
	"ls-tree": true,
	"merge-base": true,
	"merge-tree": true,
	"name-rev": true,
	"range-diff": true,
	"request-pull": true,
	"rev-list": true,
	"rev-parse": true,
	shortlog: true,
	show: true,
	"show-branch": true,
	"show-ref": true,
	status: true,
	var: true,
	"verify-commit": true,
	"verify-pack": true,
	"verify-tag": true,
	version: true,
	whatchanged: true,
	// Working-tree and index edits: harmless because checkpoints stage everything anyway.
	add: true,
	apply: true,
	mv: true,
	rm: true,
};

/** Global options that consume the following word. */
const GLOBAL_WITH_VALUE: Record<string, true> = {
	"-C": true,
	"-c": true,
	"--git-dir": true,
	"--work-tree": true,
	"--namespace": true,
	"--config-env": true,
	"--super-prefix": true,
};

const BRANCH_WRITE_FLAGS: Record<string, true> = {
	"-d": true,
	"-D": true,
	"-m": true,
	"-M": true,
	"-c": true,
	"-C": true,
	"-f": true,
	"-u": true,
	"--delete": true,
	"--move": true,
	"--copy": true,
	"--force": true,
	"--set-upstream-to": true,
	"--unset-upstream": true,
	"--edit-description": true,
	"--track": true,
	"--no-track": true,
	"--create-reflog": true,
};

const BRANCH_LIST_FLAGS: Record<string, true> = {
	"-l": true,
	"--list": true,
	"-a": true,
	"--all": true,
	"-r": true,
	"--remotes": true,
	"--contains": true,
	"--no-contains": true,
	"--merged": true,
	"--no-merged": true,
	"--points-at": true,
};

const TAG_WRITE_FLAGS: Record<string, true> = {
	"-a": true,
	"-s": true,
	"-u": true,
	"-f": true,
	"-d": true,
	"-m": true,
	"-F": true,
	"--annotate": true,
	"--sign": true,
	"--local-user": true,
	"--force": true,
	"--delete": true,
	"--message": true,
	"--file": true,
};

const TAG_LIST_FLAGS: Record<string, true> = {
	"-l": true,
	"--list": true,
	"--contains": true,
	"--no-contains": true,
	"--merged": true,
	"--no-merged": true,
	"--points-at": true,
	"-v": true,
	"--verify": true,
};

const CONFIG_READ_FLAGS: Record<string, true> = {
	"--get": true,
	"--get-all": true,
	"--get-regexp": true,
	"--get-urlmatch": true,
	"--list": true,
	"-l": true,
	get: true,
	list: true,
};

const CONFIG_WRITE_FLAGS: Record<string, true> = {
	"--add": true,
	"--replace-all": true,
	"--unset": true,
	"--unset-all": true,
	"--rename-section": true,
	"--remove-section": true,
	"-e": true,
	"--edit": true,
	set: true,
	unset: true,
	"rename-section": true,
	"remove-section": true,
	edit: true,
};

const flagName = (arg: string) => arg.split("=", 1)[0]!;

/** True when `git <args>` would modify repository state. */
export function isGitWrite(args: readonly string[]): boolean {
	let i = 0;
	while (i < args.length) {
		const arg = args[i]!;
		if (GLOBAL_WITH_VALUE[arg]) i += 2;
		else if (arg.startsWith("-")) i += 1;
		else break;
	}
	const sub = args[i];
	if (sub === undefined) return false;
	const rest = args.slice(i + 1);
	const flags = rest.filter((a) => a.startsWith("-")).map(flagName);
	const positionals = rest.filter((a) => !a.startsWith("-"));
	const first = rest[0];
	switch (sub) {
		case "branch":
			if (flags.some((f) => BRANCH_WRITE_FLAGS[f] || /^-[a-zA-Z]*[dDmMcCfu]/.test(f))) return true;
			// A bare name creates a branch; with a list flag it is a pattern.
			return positionals.length > 0 && !flags.some((f) => BRANCH_LIST_FLAGS[f]);
		case "tag":
			if (flags.some((f) => TAG_WRITE_FLAGS[f] || /^-[a-zA-Z]*[asudmfF]/.test(f))) return true;
			return positionals.length > 0 && !flags.some((f) => TAG_LIST_FLAGS[f] || f.startsWith("-n"));
		case "stash":
			return first !== "list" && first !== "show";
		case "worktree":
			return first !== "list";
		case "remote":
			return !(first === undefined || first === "-v" || first === "--verbose" || first === "show" || first === "get-url");
		case "config":
			if (rest.some((a) => CONFIG_READ_FLAGS[flagName(a)])) return false;
			// `git config [--global] <key>` reads; a value, or any editing flag, writes.
			return rest.some((a) => CONFIG_WRITE_FLAGS[flagName(a)]) || positionals.length !== 1;
		case "reflog":
			return first === "expire" || first === "delete" || first === "drop";
		case "notes":
			return !(first === undefined || first === "list" || first === "show");
		case "submodule":
			return !(first === undefined || first === "status" || first === "summary");
		case "sparse-checkout":
			return first !== "list";
		case "lfs":
			return !(first === "ls-files" || first === "status" || first === "env" || first === "version");
		case "symbolic-ref":
			return flags.some((f) => f === "-d" || f === "--delete" || f === "-m") || positionals.length > 1;
		case "hash-object":
			return flags.includes("-w");
		default:
			return !READ_ONLY[sub];
	}
}

interface Lexed {
	commands: string[][];
	/** Bodies of `$(...)` and backtick substitutions, scanned recursively. */
	nested: string[];
}

/** Index of the `)` closing the `(` at `open`, skipping quoted text. */
function closingParen(src: string, open: number): number {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === "\\") i++;
		else if (c === "'" || c === '"') {
			let end = i + 1;
			while (end < src.length && src[end] !== c) end += c === '"' && src[end] === "\\" ? 2 : 1;
			i = end;
		} else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i;
	}
	return src.length;
}

function closingBacktick(src: string, from: number): number {
	for (let i = from; i < src.length; i++) {
		if (src[i] === "\\") i++;
		else if (src[i] === "`") return i;
	}
	return src.length;
}

const OPERATOR = /[;&|()\n]/;

function lex(src: string): Lexed {
	const commands: string[][] = [];
	const nested: string[] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	const endWord = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endCommand = () => {
		endWord();
		if (words.length > 0) commands.push(words);
		words = [];
	};
	let i = 0;
	while (i < src.length) {
		const c = src[i]!;
		if (c === "\\") {
			if (src[i + 1] !== "\n") {
				word += src[i + 1] ?? "";
				inWord = true;
			}
			i += 2;
		} else if (c === "'") {
			const end = src.indexOf("'", i + 1);
			const stop = end === -1 ? src.length : end;
			word += src.slice(i + 1, stop);
			inWord = true;
			i = stop + 1;
		} else if (c === '"') {
			inWord = true;
			i++;
			while (i < src.length && src[i] !== '"') {
				const d = src[i]!;
				if (d === "\\" && i + 1 < src.length) {
					word += src[i + 1];
					i += 2;
				} else if (d === "$" && src[i + 1] === "(") {
					const end = closingParen(src, i + 1);
					nested.push(src.slice(i + 2, end));
					i = end + 1;
				} else if (d === "`") {
					const end = closingBacktick(src, i + 1);
					nested.push(src.slice(i + 1, end));
					i = end + 1;
				} else {
					word += d;
					i++;
				}
			}
			i++;
		} else if (c === "$" && src[i + 1] === "(") {
			const end = closingParen(src, i + 1);
			nested.push(src.slice(i + 2, end));
			inWord = true;
			i = end + 1;
		} else if (c === "`") {
			const end = closingBacktick(src, i + 1);
			nested.push(src.slice(i + 1, end));
			inWord = true;
			i = end + 1;
		} else if (c === "#" && !inWord) {
			const end = src.indexOf("\n", i);
			i = end === -1 ? src.length : end;
		} else if (c === " " || c === "\t") {
			endWord();
			i++;
		} else if (c === "<" || c === ">") {
			// Redirection: drop an fd number before it and the target word after it.
			if (/^\d+$/.test(word)) {
				word = "";
				inWord = false;
			}
			endWord();
			while (i < src.length && /[<>&|]/.test(src[i]!)) i++;
			while (src[i] === " " || src[i] === "\t") i++;
			while (i < src.length && !/[\s;&|()<>]/.test(src[i]!)) i++;
		} else if (OPERATOR.test(c)) {
			endCommand();
			i++;
		} else {
			word += c;
			inWord = true;
			i++;
		}
	}
	endCommand();
	return { commands, nested };
}

/** Commands that run their arguments as another command. */
const WRAPPERS: Record<string, true> = {
	"!": true,
	"{": true,
	builtin: true,
	chronic: true,
	command: true,
	do: true,
	elif: true,
	else: true,
	env: true,
	exec: true,
	if: true,
	ionice: true,
	nice: true,
	nohup: true,
	stdbuf: true,
	sudo: true,
	then: true,
	time: true,
	timeout: true,
	until: true,
	watch: true,
	while: true,
	xargs: true,
};

const SHELLS: Record<string, true> = { sh: true, bash: true, zsh: true, dash: true, ksh: true };

const MAX_DEPTH = 5;

function scanCommand(words: string[], depth: number): string | null {
	let i = 0;
	while (i < words.length) {
		const word = words[i]!;
		const name = word.split("/").pop()!;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) i++;
		else if (WRAPPERS[name]) {
			i++;
			while (i < words.length && (words[i]!.startsWith("-") || (name === "timeout" && /^\d/.test(words[i]!)))) i++;
		} else break;
	}
	const cmd = words[i];
	if (cmd === undefined) return null;
	const name = cmd.split("/").pop()!;
	const args = words.slice(i + 1);
	if (name === "git") return isGitWrite(args) ? ["git", ...args].join(" ") : null;
	if (SHELLS[name]) {
		const flag = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
		const script = flag === -1 ? undefined : args[flag + 1];
		return script === undefined ? null : findGitWrite(script, depth + 1);
	}
	if (name === "eval") return findGitWrite(args.join(" "), depth + 1);
	return null;
}

/** The first state-changing git invocation in a shell command line, or null. */
export function findGitWrite(command: string, depth = 0): string | null {
	if (depth > MAX_DEPTH) return null;
	const { commands, nested } = lex(command);
	for (const words of commands) {
		const hit = scanCommand(words, depth);
		if (hit) return hit;
	}
	for (const inner of nested) {
		const hit = findGitWrite(inner, depth + 1);
		if (hit) return hit;
	}
	return null;
}

const STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * Scan eval-tool code (Python or JS): `!shell` lines, and string literals that spell out a
 * git command alone (`$\`git push\``) or as an argv list (`["git", "commit"]`).
 */
export function findGitWriteInCode(code: string): string | null {
	for (const raw of code.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("!")) {
			const hit = findGitWrite(line.slice(1));
			if (hit) return hit;
			continue;
		}
		const literals = [...line.matchAll(STRING_LITERAL)].map((m) => m[2]!);
		for (const candidate of literals.length > 1 ? [...literals, literals.join(" ")] : literals) {
			const hit = findGitWrite(candidate);
			if (hit) return hit;
		}
	}
	return null;
}
