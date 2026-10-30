---
name: design-system-init
description: "Create or refresh a repo's design-system skill, the project overlay that the designer agent autoloads next to ui-ux-guide. Use when setting up the designer in a new project or when the repo's tokens, components or verification loop changed."
---

# Init a repo design-system skill

Writes `<skills dir>/design-system/SKILL.md` for the current repo. The `designer` agent autoloads two skills: `ui-ux-guide` (global, project-independent law) and `design-system` (this repo's facts). Implementing agents load both before touching UI. The file is meant to be edited by hand afterwards, so it stays short, plain and cited.

## Contract (the designer depends on it)

- Frontmatter `name: design-system`, exactly. Any other name is never autoloaded.
- `description`: one sentence naming the product, the token file, the component directory, the notable interaction primitives, and "Load together with `ui-ux-guide` before writing or reviewing markup or styles in `<ui paths>`."
- Opening paragraph, verbatim idea: `skill://ui-ux-guide` holds the general rules; this skill maps them onto this repo; section numbers match; where the two disagree this skill wins; sections with nothing repo-specific are left out.
- Section headings reuse the global numbers: `## <n>. <title>`. Read the current list first (`grep` `^## ` in `skill://ui-ux-guide`) instead of trusting memory. Omit a section rather than leave it empty; numbers may skip.
- §12 MUST name the screenshot directory (the designer saves captures there, else `/tmp/designer-screenshots/`) and the dev server URL.
- Facts only, each with a path (and a line when it points at one definition). No restating of general rules from `ui-ux-guide`; only what is different or concrete here.

## Where it goes

1. A `design-system` skill already exists (`skill://design-system` resolves, or the file is in the repo): switch to refresh mode. Diff facts against the code, fix stale ones, add missing ones, and never rewrite hand-written prose without asking. Stop here if nothing changed.
2. The repo already keeps skills in `.agents/skills/`, `.omp/skills/` or `.claude/skills/`: use that directory. If it uses `.agents/skills/` plus symlinks in `.claude/skills/`, add the matching symlink.
3. Otherwise `.omp/skills/design-system/SKILL.md`.

## Discover (evidence first)

Read the repo before asking anything. On a large repo fan out two `scout` tasks (styles and tokens; components and interaction), each capped at about 20 tool calls. Collect, with paths:

| Section | Look for |
|---|---|
| §0 Procedure | component directory and any index of it, token file, closest reference routes/pages, lint hooks or rules that enforce UI rules |
| §1 Reuse | import alias, icon library and how it is rendered, avatar/breadcrumb/list primitives, global utility classes that must not be redefined |
| §2 Tokens | CSS custom properties (`:root`), Tailwind `theme`, token JSON; group them into a table by purpose (background, border, text, brand, semantic, radius, shadow, motion, widths, z-index); dark mode mechanism |
| §3 Typography | font family and how it loads, global line heights, text utilities |
| §4 Layout | container widths, divider and spacing conventions |
| §5 Optimistic updates | the framework's mutation pattern (remote functions, React Query `onMutate`, server actions, SWR `mutate`), one canonical example with path:line |
| §6 Buttons & inputs | loading-button component, global button/input styles, validation styling and error text class |
| §7 Feedback / §8 Wait | toast API, empty state, spinner or skeleton components |
| §9 Depth | which shadow token for cards, menus, modals |
| §10 Motion | duration tokens, reduced-motion helper, scroll-reveal utility |
| §11 Modern CSS & HTML | the floating-panel mechanism (popover action, Floating UI, Radix), tooltip mechanism, which native features are already applied globally |
| §12 After editing | check/lint/type commands from `package.json` (or the build tool), autofixers, browser verification: dev server URL (from scripts or config), screenshot directory, viewport sizes, anything a signed-in browser needs (`/browser-login`) |
| §13 Anti-patterns | repo-specific mistakes the code or hooks reject |
| §14 to §17 | dashboard components, behavioral patterns (upgrade prompts, gates), product metaphors, sound, multiplayer/shared state |
| §18 to §19 | error/offline/empty state components, undo toast helper, soft-delete or "Recently deleted" mechanism, submenu safe-area and tooltip delay settings in the menu/tooltip library, double-click handling, autosave pattern |
| §20 Money trust | fee/quote breakdown component, transaction status enum and the screen each state renders, freeze and limit controls, balance-masking toggle and where it persists, support channels and their entry points |

A fact you could not confirm in code is not written. Keep it for the questions below.

## Ask (only what code cannot answer)

One `ask` call, batched:
- Screenshot directory when none exists. Offer a gitignored path such as `.omp/screenshots/` (and add it to `.gitignore`) or `/tmp/designer-screenshots/`.
- Product metaphors, tone, and hard dos/don'ts for §16/§17, if the repo shows none.
- Anything ambiguous found in discovery (two competing token files, two component libraries).

## Write

- Keep it under about 250 lines. Tables for tokens, bullets for everything else, one short canonical code sample per pattern at most.
- Prose follows `skill://unslop`; also honor the repo's own lint rules (for example a no-em-dash check).
- Name real components and tokens only.

## Verify

1. Every path in the file exists (`glob`), every token named appears in the token source (`grep`).
2. Run the repo's own formatter or lint on the file if it lints markdown.
3. Fresh-process discovery check from the repo root: `omp -p --no-session "Read skill://design-system and reply with its name field and the list of its ## headings."` The reply must show `design-system` and the numbered headings.

## Report

- File path and the sections written.
- Sections omitted, each with the one question that would fill it, so the user can add them by hand.
- Any symlink or `.gitignore` change made.
