# Batch tool calls

A turn costs ~13s of wall clock: time to first token, then generation, no matter how
little it does. Turns are the scarce resource; extra calls inside one turn are nearly free.
The `batch-guard` extension counts single-call turns and appends a reminder to the tool
result when a streak builds. Do not wait for it.

- Decide the whole next step, then issue every call it needs in ONE message.
- A turn containing a single `read`, `grep`, or `glob` is a defect unless that call's
  arguments were unknowable before the previous result.
- Reading four files you might need beats four turns discovering you needed them.
- Compound bash is encouraged: `cd` is not needed (use `cwd`), but `a && b && c` in one
  call is one turn instead of three. Only a *bare* `rg`/`find`/`grep -r` gets rerouted to its
  tool; the same command inside a pipeline runs. In-place `sed -i`/`perl -i` is blocked in
  any position: use `edit`.
- Serialize only on a true data dependency, where the next call's arguments come out of
  this call's output.

## The summary-then-range two-step

`read` on a file over 100 lines returns a structural summary, so the ranged follow-up is a
second turn. Collapse it:

- Know the range already? Read `path:120-260` directly, first time.
- Do not know it? `grep` the symbol **in the same turn** as the reads of the other files
  you need, then read the range it reports alongside your next batch.
- Never send a lone ranged read of a file you just summarized.

# Verify once, with the language server

`tsgo` (registered in `~/.omp/agent/lsp.json`) serves TypeScript and omp's built-in
`svelteserver` serves Svelte; both answer in well under a second.

- Type errors arrive **inline on the write/edit result** (`lsp.diagnosticsOnWrite`). Read
  them there. Do not shell out to confirm what the result already told you.
- Symbol work (`definition`, `references`, `rename`, `code_actions`) goes through `lsp`,
  never a grep sweep. In a SvelteKit repo, `references` also returns
  `.svelte-kit/types/**/proxy+*.ts`: those are generated mirrors of the real route file
  next to them, not extra call sites.
- The project's check, lint and test commands run **once, at the end of the task**, chained
  into a single bash call. Running them mid-task costs 20-35s each and re-reports what the
  LSP already showed.

# Route subagents by role, and give them a shape

Each agent runs on a model role (`task.agentModelOverrides`), and each role is whatever model
the user assigned in `/models`. Pick the agent by what the work needs, not by habit.

- `scout` runs the `smol` role: read-only mapping, breadth searches, dependency and API
  lookups.
- `sonic` runs the `smol` role. It is the **default worker**: any task whose outcome you can
  state up front goes to `sonic`, not `task`. That covers edits whose location and shape you
  already know, pattern-following changes across files, renames, docs and changelog updates,
  running a command and reporting the result, and data collection. If you could write the
  acceptance check before it starts, it is a `sonic` task.
- `task` runs the `default` role; `reviewer` and `security-reviewer` run the `slow` role. Use
  `task` only when the work needs design choices, debugging with an open cause, or
  correctness judgment across modules. Choosing between `sonic` and `task`, pick `sonic`.
- Pass `effort: lo|med|hi` per spawn to dial thinking within the agent's model;
  `task.maxEffort: high` caps it.
- Never hand read-only research to a `task` agent because the question feels important.
  Give `scout` a sharper brief instead.

Shape matters as much as the role:

- **Never spawn exactly one `task` subagent.** A single child is pure overhead: spawn, wait,
  integrate, no parallelism. Either do it inline or fan out two or more genuinely
  independent slices. Exceptions: a `designer` consult (when enabled) is a single blocking
  call by design, and one `sonic` or `scout` spawn is fine when you keep working while it
  runs, since that moves the tokens onto the `smol` model.
- **Bound every brief.** State the budget in the task text ("≤20 tool calls, then report
  what you found"). Unbounded scouts can run hundreds of messages.
- **Do not idle in `hub wait`.** Wait only when there is no remaining work; otherwise keep
  implementing and collect results later.
- **Push breadth reading down.** Landing `read` results in a scout's context instead of
  yours keeps the main session small, and a small session answers faster.

# Reuse the running dev server

When the project has a dev server, the user starts it outside the session and leaves it
running.

- NEVER start, restart, or `hub start` a dev server, watcher, or `preview` process on your
  own initiative. A global `tool_call` guard blocks the attempt when one is already listening.
- Locate it instead: run `node ~/.omp/agent/bin/dev-servers.mjs` from the repo. It lists the
  ports owned by processes running inside the repo (5173 vite, 8787 wrangler, 3000 next,
  4321 astro). Use `http://localhost:<port>`.
- Nothing listening in a project that has a dev server means it crashed. Say so, start at
  most one replacement when you actually need it to verify a change, and tell the user you
  started it.
- Output from a server you did not start is not visible to `hub logs`. Verify through the
  app itself (HTTP responses), not by tailing logs.
