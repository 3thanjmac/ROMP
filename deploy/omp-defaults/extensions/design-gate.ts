import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

/**
 * Design gate: points the agent at the read-only `designer` subagent before it
 * implements user-facing UI.
 *
 * It used to `block` the first UI write of a session, which cost a guaranteed
 * round trip (and discarded a whole streamed component) even when the answer
 * was "retry the identical call". The notice now rides along on a tool result
 * the agent already receives, so it costs nothing, and it fires at the first
 * UI *read* -- before any markup has been composed, when consulting a designer
 * is still cheap.
 *
 * Opt-in: the gate is on only while the `designer` agent is enabled, i.e. not
 * listed in `task.disabledAgents` (the shared defaults list it). Modes:
 *   off     disabled
 *   nudge   (default once enabled) one free-riding notice per session, never blocks
 *   strict  block every UI write until a designer consult is recorded
 * OMP_DESIGN_GATE=off|nudge|strict overrides both.
 *
 * Only the main session is gated. The factory is rebound to every subagent and
 * advisor in the process, and they share this module's state: a child's
 * session_start would wipe the parent's recorded consult, and a scout or the
 * designer itself would be told to dispatch a designer it cannot spawn.
 */

type Mode = "off" | "nudge" | "strict";

const ENV_MODE: Mode | undefined = (() => {
  const raw = (process.env.OMP_DESIGN_GATE ?? "").trim().toLowerCase();
  return raw === "off" || raw === "nudge" || raw === "strict" ? raw : undefined;
})();

const disabledAgents = lookup("task.disabledAgents");

/** Read per call: settings reload live, so opting in takes effect without a restart. */
function mode(pi: ExtensionAPI): Mode {
  if (ENV_MODE) {
    return ENV_MODE;
  }
  const disabled = disabledAgents?.get(pi.pi.settings);
  return Array.isArray(disabled) && disabled.includes("designer") ? "off" : "nudge";
}

const UI_EXTENSIONS = /\.(svelte|scss|css|tsx|jsx|vue|astro|html|htm)$/i;
const UI_DIRECTORIES = /(^|\/)(routes|components|styles|ui|views|pages|layouts)(\/|$)/i;
const SKIP_PATH =
  /(^|\/)(node_modules|\.svelte-kit|dist|build|\.playwright)(\/|$)|\.(test|spec)\.|\.d\.ts$/i;
const NON_FS_PATH = /^[a-z][a-z0-9+.-]*:\/\//i;
const EDIT_SECTION = /^\[([^\]\n]+?)#[0-9A-Fa-f]{4}\]$/gm;

const READ_TOOLS: Record<string, true> = { read: true, grep: true, glob: true };
const WRITE_TOOLS: Record<string, true> = { write: true, edit: true, apply_patch: true };

const state = {
  consulted: false,
  notified: false,
};

function isUiPath(path: string): boolean {
  if (!path || NON_FS_PATH.test(path) || SKIP_PATH.test(path)) {
    return false;
  }
  return UI_EXTENSIONS.test(path) || UI_DIRECTORIES.test(path);
}

function readString(source: unknown, key: string): string {
  if (source && typeof source === "object" && key in source) {
    const value = Reflect.get(source, key);
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function targetPaths(toolName: string, input: unknown): string[] {
  const name = toolName.toLowerCase();

  if (name === "write" || name === "read" || name === "grep" || name === "glob") {
    // `read` and `grep` accept `path:selector` and `a; b` roots.
    const raw = readString(input, "path");
    return raw
      .split(";")
      .map((entry) => entry.trim().split(":")[0] ?? "")
      .filter((entry) => entry.length > 0);
  }

  if (name === "edit" || name === "apply_patch") {
    const patch = readString(input, "input") || readString(input, "patch");
    if (!patch) {
      return [];
    }
    const paths: string[] = [];
    for (const match of patch.matchAll(EDIT_SECTION)) {
      const path = match[1]?.trim();
      if (path) {
        paths.push(path);
      }
    }
    return paths;
  }

  return [];
}

function dispatchesDesigner(input: unknown): boolean {
  if (!input || typeof input !== "object") {
    return false;
  }
  const tasks = Reflect.get(input, "tasks");
  if (!Array.isArray(tasks)) {
    return false;
  }
  return tasks.some((item) => readString(item, "agent").toLowerCase() === "designer");
}

function notice(paths: string[], blocking: boolean): string {
  const files = paths
    .slice(0, 6)
    .map((path) => `    ${path}`)
    .join("\n");
  const tail = blocking
    ? "Strict mode: the write stays blocked until a `designer` dispatch is recorded. Set OMP_DESIGN_GATE=nudge or off to relax it."
    : "Nothing is blocked and this fires once per session. Skip it only if the change is not visual (logic, types, copy, data plumbing) or you already have a brief.";

  return [
    "[design-gate] You are touching user-facing UI:",
    "",
    files,
    "",
    "Dispatch the read-only `designer` agent BEFORE you write markup (runs on the",
    "designer model role, blocks until it answers, cannot edit). Hand it the concrete",
    "file paths you just read, the reference surface, and the real data states. Then",
    "implement its implementation prompt yourself and verify it.",
    "",
    '    task({ context: <what you are building>, tasks: [{ agent: "designer", task: <files, states, constraints> }] })',
    "",
    tail,
  ].join("\n");
}

export default function designGate(pi: ExtensionAPI) {
  pi.setLabel("Design gate");

  if (ENV_MODE === "off") {
    return;
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent?.kind === "sub") {
      return;
    }
    state.consulted = false;
    state.notified = false;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (ctx.agent?.kind === "sub") {
      return;
    }
    const tool = event.toolName.toLowerCase();

    if (tool === "task" && dispatchesDesigner(event.input)) {
      state.consulted = true;
      return;
    }

    if (mode(pi) !== "strict" || state.consulted || !WRITE_TOOLS[tool]) {
      return;
    }

    const paths = targetPaths(tool, event.input).filter(isUiPath);
    if (paths.length === 0) {
      return;
    }

    return { block: true, reason: notice(paths, true) };
  });

  // Nudge mode never blocks: the notice rides on a result the agent already gets.
  pi.on("tool_result", async (event, ctx) => {
    if (ctx.agent?.kind === "sub") {
      return;
    }
    const tool = event.toolName.toLowerCase();

    if (mode(pi) !== "nudge" || state.consulted || state.notified || event.isError) {
      return;
    }
    if (!READ_TOOLS[tool] && !WRITE_TOOLS[tool]) {
      return;
    }

    const paths = targetPaths(tool, event.input).filter(isUiPath);
    if (paths.length === 0) {
      return;
    }

    state.notified = true;
    return {
      content: [...event.content, { type: "text" as const, text: `\n${notice(paths, false)}` }],
    };
  });
}
