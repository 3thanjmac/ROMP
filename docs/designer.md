# Designer

The shared OMP settings (`deploy/omp-defaults/`) include a design consultant that runs on its own model role. It is off by default. This page covers what each piece does, how to turn it on, and how to use it.

## Pieces

| Piece | File | What it does |
|---|---|---|
| `designer` agent | `agents/designer.md` | A read-only subagent on the `designer` model role. It has only `read`, `grep`, `glob`, `web_search` and `yield`, so it cannot edit files, run commands or spawn subagents. It is blocking: the caller waits for its answer. It answers with `## Direction` and one fenced implementation prompt, or with `## Findings` when asked to critique screenshots or a live page. |
| `/design` command | `commands/design.md` | Gathers the grounding (files, tokens, data states, dev server URL), dispatches the designer, then implements the returned prompt and verifies it. |
| Design gate | `extensions/design-gate.ts` | Points the main session at the designer when it first touches UI files. |
| Designer advisor | `WATCHDOG.yml` | An optional reviewer that comments on user-facing changes every turn, on the designer model. |

All paths are relative to `deploy/omp-defaults/`, which `romp omp-defaults` copies into `~/.omp/agent/` (see [deploy.md §8](deploy.md#8-shared-omp-settings)).

## Turning it on

1. In `omp`, open `/models` and assign a model to the `designer` role. Model choices are never shipped: `romp omp-defaults` strips `modelRoles` and the other model settings from `config.yml`, so each user picks their own.
2. Enable the agent:

   ```sh
   omp config set task.disabledAgents '[]'
   ```

   The shared defaults list only `designer` in `task.disabledAgents`. If you have disabled other agents yourself, set the list to those instead of `[]`. Enabling the agent also enables `/design` and the design gate. Settings reload live, so no restart is needed.
3. Optional: per-turn review. Set `enabled: true` under `Designer` in `~/.omp/agent/WATCHDOG.yml` and run `omp config set advisor.enabled true`. Every turn is then reviewed with the designer model, which costs tokens.

These are your own values, so later `romp omp-defaults` updates leave them in place.

## Per-repo design system

The designer loads two skills automatically: `ui-ux-guide` (general design rules) and the repo's `design-system` skill (its tokens, components, verification loop, screenshot directory and dev server URL). Where they disagree, `design-system` wins. Without a `design-system` skill the designer has only the general rules and has to find the repo's tokens itself within its read budget.

To create or refresh it, ask the agent to run the `design-system-init` skill in the repo. Run it again when the tokens, components or verification commands change. The skill's frontmatter must say `name: design-system` exactly, or it is never loaded.

## Using it

- `/design <request>` runs the whole flow: consult, implement, verify.
- Direct dispatch from any main session:

  ```
  task({ context: "<what you are building>", tasks: [{ agent: "designer", task: "<files with line ranges, reference surface, token excerpts, data states, dev server URL>" }] })
  ```

  The designer is limited to about one batch of reads (8 tool calls, plus 20 browser calls), so anything you already read and pass along saves it a round trip.
- Critique mode: give it screenshot paths or a URL on the running dev server. If a chrome-devtools MCP device is mounted, it opens its own tab and captures 1920×1080, 1280×800 and 390×844 (mobile). Captures go to the screenshot directory named in `design-system`, else `/tmp/designer-screenshots/`. Without the device it marks visual claims `UNVERIFIED:`. A redirect to a sign-in page ends the critique with `sign-in required: <url>`.
- After it answers, the designer stays reachable: send follow-up questions with `hub send` instead of guessing at decisions the brief left open.
- The implementing agent owns correctness. Anything flagged `UNVERIFIED:`, or a token, component or file that turns out not to exist, is fixed during implementation and reported in the final message.

## Design gate modes

| Mode | Behaviour |
|---|---|
| `off` | Inactive. Always the mode while `designer` is in `task.disabledAgents`. |
| `nudge` | Default once the agent is enabled. The first `read`, `grep`, `glob`, `write` or `edit` of a UI path in a session gets a one-time notice appended to its result. Never blocks. |
| `strict` | Blocks every `write`, `edit` or `apply_patch` to a UI path until the session has dispatched the designer. |

`OMP_DESIGN_GATE=off|nudge|strict` in the environment overrides the setting-based mode. `strict` is available only through this variable.

A UI path is a file ending in `.svelte`, `.scss`, `.css`, `.tsx`, `.jsx`, `.vue`, `.astro`, `.html` or `.htm`, or a file under a `routes`, `components`, `styles`, `ui`, `views`, `pages` or `layouts` directory. `node_modules`, `.svelte-kit`, `dist`, `build`, `.playwright`, test/spec files and `.d.ts` files are skipped.

Only the main session is gated. Subagents (including the designer) are never nudged or blocked.
