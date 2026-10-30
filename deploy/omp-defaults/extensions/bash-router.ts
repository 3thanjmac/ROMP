import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Routes bare shell commands to the dedicated tools, WITHOUT punishing compound
 * lines.
 *
 * `bashInterceptor.patterns` matches each segment of a compound command, so
 * `cd repo && pnpm check && grep -rn foo src` was rejected because of its third
 * segment. That put the interceptor in direct conflict with the batching rule:
 * folding several shell facts into one turn is exactly what we want, and it was
 * the thing most likely to be blocked. In one 14-day sample, 246 interceptor
 * blocks cost a full round trip each and 131 of them started with `cd`.
 *
 * Policy here:
 *   - a habit rule fires only when the offending command IS the whole command
 *   - `sed -i` and friends fire always: in-place stream editing bypasses the
 *     edit tool's snapshot anchoring, which is correctness, not style
 *   - `git grep` is never rerouted; the grep tool cannot search a revision
 *   - searches into ignored trees name `gitignore: false` instead of a generic
 *     "use the grep tool", because that is the part the model gets wrong
 */

/** In-place stream edits bypass snapshot anchoring; blocked in any position. */
const ALWAYS = [
  {
    test: /^\s*(?:sed|perl)\s+(?:-[A-Za-z]*\s+)*-[A-Za-z]*i\b/,
    tool: "edit",
    message:
      "Use the `edit` tool instead of in-place sed/perl. It anchors to a snapshot and shows a diff; `sed -i` silently rewrites files the session has not seen."
  },
  {
    test: /^\s*awk\s+.*-i\s+inplace/,
    tool: "edit",
    message: "Use the `edit` tool instead of `awk -i inplace`."
  }
] as const;

/** Habit rules: only when the command is a single bare invocation. */
const BARE = [
  {
    test: /^\s*(?:rg|ripgrep|ag|ack)\b/,
    tool: "grep",
    message:
      "Use the `grep` tool instead of rg/ag/ack. It respects .gitignore and returns line-anchored output. Pass `gitignore: false` to reach node_modules or build output."
  },
  {
    test: /^\s*grep\b(?=.*\s-[A-Za-z]*[rR])/,
    tool: "grep",
    message:
      "Use the `grep` tool for recursive searches. Pass `gitignore: false` to reach node_modules, .svelte-kit, dist, or build. Single-file grep, grep -c/-o/-q, `git grep`, and pipeline stages may stay in bash."
  },
  {
    test: /^\s*(?:find|fd|locate)\b(?=.*\s-(?:name|iname|type|path|ipath|regex|glob))/,
    tool: "glob",
    message:
      "Use the `glob` tool instead of find/fd for name or type matching. It respects .gitignore and is faster. Pass `gitignore: false` for node_modules."
  },
  {
    test: /^\s*(?:less|more)\s+/,
    tool: "read",
    message: "Use the `read` tool instead of a pager. less/more block without a terminal."
  },
  {
    test: /^\s*(?:echo|printf)\b.*>>?\s*(?!\/dev\/)[^&\s]/,
    tool: "write",
    message:
      "Use the `write` tool instead of echo/printf redirection. It handles encoding and creates parent directories."
  },
  {
    test: /^\s*cat\s*<</,
    tool: "write",
    message: "Use the `write` tool instead of a cat heredoc."
  }
] as const;

/** `git grep` reaches revisions the grep tool cannot; never reroute it. */
const EXEMPT = /^\s*git\s+grep\b/;

/** A heredoc body contains newlines that are not command separators. */
const HEREDOC = /^\s*cat\s*<</;

/**
 * Shell segments outside quotes, command substitution, and backticks. Splitting
 * on `;`, newline, `&&`, `||` and `|` is enough to tell "one bare command" from
 * "a pipeline the model deliberately folded into one turn".
 */
function segments(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let depth = 0;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] as string;

    if (char === "\\" && quote !== "'") {
      current += char + (command[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char === "`" ? undefined : (char as '"' | "'");
      current += char;
      if (char === "`") {
        depth += 1;
      }
      continue;
    }
    if (char === "$" && command[i + 1] === "(") {
      depth += 1;
      current += "$(";
      i += 1;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth -= 1;
      current += char;
      continue;
    }
    if (depth > 0) {
      current += char;
      continue;
    }
    if (char === ";" || char === "\n") {
      parts.push(current);
      current = "";
      continue;
    }
    if (char === "&" && command[i + 1] === "&") {
      parts.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (char === "|") {
      parts.push(current);
      current = "";
      if (command[i + 1] === "|") {
        i += 1;
      }
      continue;
    }
    current += char;
  }
  parts.push(current);

  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

export default function bashRouter(pi: ExtensionAPI) {
  pi.setLabel("Bash router");

  pi.on("tool_call", async (event) => {
    if (event.toolName.toLowerCase() !== "bash") {
      return;
    }
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    if (command.length === 0) {
      return;
    }

    // A heredoc body carries newlines that are not command separators.
    if (HEREDOC.test(command)) {
      return {
        block: true,
        reason: "Use the `write` tool instead of a cat heredoc. It handles encoding and creates parent directories."
      };
    }

    const parts = segments(command);

    for (const part of parts) {
      if (EXEMPT.test(part)) {
        continue;
      }
      for (const rule of ALWAYS) {
        if (rule.test.test(part)) {
          return { block: true, reason: `Use the \`${rule.tool}\` tool. ${rule.message}` };
        }
      }
    }

    // Habit rules apply to a bare command only. A compound line is the batching
    // behavior we are trying to encourage, so it runs.
    if (parts.length !== 1) {
      return;
    }
    const only = parts[0] as string;
    if (EXEMPT.test(only)) {
      return;
    }
    for (const rule of BARE) {
      if (rule.test.test(only)) {
        return { block: true, reason: `Use the \`${rule.tool}\` tool. ${rule.message}` };
      }
    }
  });
}
