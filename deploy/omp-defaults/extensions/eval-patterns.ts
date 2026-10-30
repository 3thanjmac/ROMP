import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

/**
 * Applies `bash.patterns` rules to `eval` code.
 *
 * omp checks those rules only for the `bash` tool. `eval` sits at the exec tier
 * and can shell out (`!cmd`, `%pip`, `subprocess`, `Bun.$`), so under yolo a
 * command the bash policy refuses or gates runs unchecked once it moves into an
 * eval cell. This closes that path:
 *   - every `deny` rule blocks the cell
 *   - a `prompt` rule asks the user only when it opts in with `eval: true`;
 *     without the opt-in, broad prompt rules (`*shutdown*`, `*id_rsa*`) would
 *     turn ordinary Python into approval cards
 *
 * The rules are globs written for a shell line, so each one is tried against the
 * whole cell, every line (minus a leading `!` magic), and the cell with quotes,
 * commas and brackets dropped, which turns an argv list such as
 * `["git", "push", "-f", "origin"]` back into `git push -f origin`.
 */

type Rule = { match: string; approval?: string; reason?: string; eval?: boolean };

const patterns = lookup("bash.patterns");
const compiled = new Map<string, RegExp>();

/** Same semantics as bash.patterns: `*` is the only wildcard, whitespace runs collapse to one space. */
function globRegExp(glob: string): RegExp {
  let regex = compiled.get(glob);
  if (!regex) {
    const body = collapse(glob)
      .split("*")
      .map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\s\\S]*");
    regex = new RegExp(`^${body}$`);
    compiled.set(glob, regex);
  }
  return regex;
}

function collapse(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function rules(pi: ExtensionAPI): Rule[] {
  const value = patterns?.get(pi.pi.settings);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (rule): rule is Rule =>
      Boolean(rule) &&
      typeof rule === "object" &&
      typeof rule.match === "string" &&
      (rule.approval === "deny" || (rule.approval === "prompt" && rule.eval === true))
  );
}

function candidates(code: string): string[] {
  const lines = code
    .split("\n")
    .map((line) => collapse(line.replace(/^\s*!/, "")))
    .filter((line) => line.length > 0);
  const argv = collapse(code.replaceAll(/["'`,[\]]/g, " "));
  return [collapse(code), argv, ...lines];
}

function matches(rule: Rule, texts: string[]): boolean {
  const regex = globRegExp(rule.match);
  return texts.some((text) => regex.test(text));
}

export default function evalPatterns(pi: ExtensionAPI) {
  pi.setLabel("Eval bash patterns");

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName.toLowerCase() !== "eval") {
      return;
    }
    const code = (event.input as Record<string, unknown> | undefined)?.code;
    if (typeof code !== "string" || code.length === 0) {
      return;
    }
    const active = rules(pi);
    if (active.length === 0) {
      return;
    }
    const texts = candidates(code);

    const denied = active.find((rule) => rule.approval === "deny" && matches(rule, texts));
    if (denied) {
      return {
        block: true,
        reason: [
          `[eval-patterns] blocked: this eval code matches the bash.patterns deny rule \`${denied.match}\`.`,
          ...(denied.reason ? [denied.reason] : []),
          "The rule refuses the command in bash, and eval does not get around it. Do not retry it",
          "through eval, a script file, or another tool. If the user wants it run, they run it."
        ].join("\n")
      };
    }

    const gated = active.find((rule) => rule.approval === "prompt" && matches(rule, texts));
    if (!gated) {
      return;
    }
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: [
          `[eval-patterns] blocked: this eval code matches the bash.patterns prompt rule \`${gated.match}\`,`,
          "which needs the user's approval, and this session cannot ask. Report the command you",
          "need instead of running it; do not retry it through another tool."
        ].join("\n")
      };
    }
    const approved = await ctx.ui.confirm(
      "Approve eval?",
      `Prompt required by bash pattern: ${gated.match}\n\n${code}`
    );
    if (approved) {
      return;
    }
    return {
      block: true,
      reason: [
        `[eval-patterns] the user declined this eval (bash.patterns prompt rule \`${gated.match}\`).`,
        "Do not retry it through bash, eval, a script file, or another tool."
      ].join("\n")
    };
  });
}
