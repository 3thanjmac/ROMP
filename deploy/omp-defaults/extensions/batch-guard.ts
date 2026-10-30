import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Turns are the scarce resource: one costs ~13s of wall clock (TTFT plus
 * generation) no matter how little it does. In a 14-day sample of this setup
 * the main agent issued 9,511 tool turns at 1.06 calls per turn, 95% of them a
 * single call, and 5,917 of those single calls were a `read`/`grep`/`glob` that
 * returned in under a second. That is hours of latency buying nothing.
 *
 * The written rule alone has never moved the number, so this measures the
 * behavior and reports it back at the exact moment the model is choosing its
 * next action: the reminder is appended to the tool result it already receives,
 * which costs no extra round trip.
 *
 * Batches are reconstructed from `tool_call` arrival times. Every call in one
 * assistant message is dispatched together at arg-prep time, so a gap larger
 * than BATCH_GAP_MS means a new message generated in between.
 */

/** Tools that return in well under a second: never worth a turn on their own. */
const CHEAP: Record<string, true> = { read: true, grep: true, glob: true };
/** Tools that act on a target the model has usually already identified. */
const MUTATING: Record<string, true> = { edit: true, write: true, ast_edit: true, apply_patch: true };

const BATCH_GAP_MS = 1200;
/** Consecutive solo cheap batches before the first reminder. */
const CHEAP_STREAK = 3;
/** Consecutive solo mutating batches before the first reminder. */
const MUTATING_STREAK = 4;

type Batch = { size: number; tools: string[]; summarized: Set<string> };

type State = {
  lastCallAt: number;
  open: Batch | undefined;
  cheapStreak: number;
  mutatingStreak: number;
  /** Files the previous batch read as a structural summary; only the very next turn can re-read them as a two-step. */
  summarized: Set<string>;
  pending: "reread" | undefined;
};

function freshState(): State {
  return {
    lastCallAt: 0,
    open: undefined,
    cheapStreak: 0,
    mutatingStreak: 0,
    summarized: new Set(),
    pending: undefined
  };
}

/**
 * The factory is rebound to every subagent session in the same process, so module
 * state would mix parallel children into one batch timeline. Each session runner
 * owns one `sessionManager`, which keys its own state.
 */
const sessions = new WeakMap<object, State>();

function stateFor(ctx: { sessionManager: object }): State {
  let state = sessions.get(ctx.sessionManager);
  if (!state) {
    state = freshState();
    sessions.set(ctx.sessionManager, state);
  }
  return state;
}

function basePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("://")) {
    return "";
  }
  const [first] = value.split(";");
  const path = (first ?? "").trim();
  // Strip a trailing `:50-200` / `:raw` selector, keeping Windows-style drives out of scope.
  const cut = path.lastIndexOf(":");
  return cut > 1 ? path.slice(0, cut) : path;
}

function hasSelector(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const tail = value.split("/").pop() ?? "";
  return tail.lastIndexOf(":") > 0;
}

function closeBatch(state: State, batch: Batch): void {
  state.summarized = batch.summarized;
  const [only] = batch.tools;
  if (batch.size === 1 && only && CHEAP[only]) {
    state.cheapStreak += 1;
    state.mutatingStreak = 0;
    return;
  }
  if (batch.size === 1 && only && MUTATING[only]) {
    state.mutatingStreak += 1;
    state.cheapStreak = 0;
    return;
  }
  state.cheapStreak = 0;
  state.mutatingStreak = 0;
}

function reminder(kind: "cheap" | "mutating" | "reread", streak: number): string {
  const header = `[batch-guard] ${streak} turns in a row carrying one tool call.`;

  if (kind === "reread") {
    return [
      "[batch-guard] Summary read, then a ranged read of the same file, in two turns.",
      "That pair is one turn: `grep` the symbol and read the range you already know,",
      "or send the ranged read together with the next file you need. ~13s per turn."
    ].join("\n");
  }
  if (kind === "mutating") {
    return [
      header,
      "You already know the remaining edits. Issue them in ONE message: `edit` takes",
      "multiple sections, and independent files can be separate calls in the same turn."
    ].join("\n");
  }
  return [
    header,
    "read/grep/glob return in under a second, so each solo one costs ~13s of pure",
    "latency. Name every file and pattern you can already predict and send them",
    "together. Reading four files you might need beats four turns finding out."
  ].join("\n");
}

export default function batchGuard(pi: ExtensionAPI) {
  pi.setLabel("Batch guard");

  pi.on("session_start", async (_event, ctx) => {
    sessions.set(ctx.sessionManager, freshState());
  });

  pi.on("tool_call", async (event, ctx) => {
    const state = stateFor(ctx);
    const now = Date.now();
    const tool = event.toolName.toLowerCase();

    if (state.open && now - state.lastCallAt > BATCH_GAP_MS) {
      closeBatch(state, state.open);
      state.open = undefined;
    }
    state.lastCallAt = now;

    if (state.open) {
      state.open.size += 1;
      state.open.tools.push(tool);
    } else {
      state.open = { size: 1, tools: [tool], summarized: new Set() };
    }

    if (tool !== "read") {
      return;
    }
    const raw = (event.input as Record<string, unknown> | undefined)?.path;
    const path = basePath(raw);
    if (!path) {
      return;
    }
    // A ranged read, alone, of a file the previous turn took as a summary is the two-step.
    if (hasSelector(raw) && state.summarized.has(path) && state.open.size === 1) {
      state.summarized.delete(path);
      state.pending = "reread";
    } else if (!hasSelector(raw)) {
      state.open.summarized.add(path);
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const tool = event.toolName.toLowerCase();
    if (event.isError || (!CHEAP[tool] && !MUTATING[tool])) {
      return;
    }
    const state = stateFor(ctx);

    let kind: "cheap" | "mutating" | "reread" | undefined = state.pending;
    let streak = 0;

    if (!kind && state.cheapStreak >= CHEAP_STREAK && CHEAP[tool]) {
      kind = "cheap";
      streak = state.cheapStreak;
      state.cheapStreak = 0;
    } else if (!kind && state.mutatingStreak >= MUTATING_STREAK && MUTATING[tool]) {
      kind = "mutating";
      streak = state.mutatingStreak;
      state.mutatingStreak = 0;
    }

    if (!kind) {
      return;
    }
    state.pending = undefined;

    return {
      content: [...event.content, { type: "text" as const, text: `\n${reminder(kind, streak)}` }]
    };
  });
}
