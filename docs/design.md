# Web app design

How the ROMP web app looks and behaves, and why. The code is the reference for exact values: tokens in `packages/web/src/styles/tokens.css`, global styles in `global.css`, icons in `src/lib/icons.ts`, shared components in `src/lib/ui/`.

## Principles

- **Dense, dark-first developer tool.** Light theme follows `prefers-color-scheme`. Colors are OKLCH tokens; hover, pressed and soft variants are derived from them with relative color syntax rather than new literals.
- **Phone first, not phone only.** Every control on a phone sits within thumb reach. Tablet and desktop get the same windows with more of them on screen.
- **Never lose typed text.** Composers, editors and forms keep their content through disconnects, failed requests and reloads.
- **One state vocabulary.** Every live window (terminal, agent) shows the same connection states: `connecting`, `live`, `reconnecting`, `offline`, `exited`, through one `ConnDot` and one `Banner`.
- **Act, then offer Undo** instead of confirm dialogs. Closing a window ends its terminal or agent session once the Undo toast goes away; Minimize detaches the window instead, and the session keeps running under Running sessions in the Overview.
- **Self-hosted assets only**: Inter Variable and JetBrains Mono Variable via `@fontsource-variable`, icons from `@lucide/svelte` through the local registry. No third-party CSS or font URLs.
- Motion is short (about 150 ms state changes) and disabled under `prefers-reduced-motion`.

## Frame

| Layout | Width | Chrome |
|---|---|---|
| Phone | < 640 px | Bottom bar: workspace menu, overview (`focused / total`, warning dot when an agent needs input), settings, and the filled `+` launcher on the far right. No top bar. Workspaces are always in scroll mode. |
| Tablet | 640 to 1023 px | Top bar: workspace tabs, a strip minimap (scroll mode), offline chip, scroll/tile switch, "New window" (`Alt O`), settings, avatar. |
| Desktop | ≥ 1024 px | Same as tablet. |

The app is sized from `visualViewport` (`--vvh`), not `100vh`, so the on-screen keyboard never covers the terminal's extra-keys row or the agent composer. On a phone the bottom bar hides while the keyboard is open.

## Windows

Every window has the same title bar in both modes: kind icon, title, then per-window badges (agent "Working" / "Needs input", editor save status), client count and connection dot for live sessions, width preset (scroll mode), a "more" menu (with Minimize for live sessions) and close. The focused window gets an accent border and a brighter title bar.

- **Scroll mode** (niri-style): windows are columns on a horizontal strip, each one third, half, two thirds or full width. On a phone every column is full width and the strip snaps one column per swipe; the stored width is untouched, so the same workspace looks right on a desktop.
- **Tile mode** (dwindle-style): windows fill a binary split tree. Split handles drag (clamped 15% to 85%), reset on double-click, and move by 5% with the arrow keys when focused.
- Switching modes keeps the same windows. Layout is saved to `/api/state` (debounced) and reloaded when the tab becomes visible again, so another device picks it up. Last write wins.

## Launching and switching

One list of items feeds three surfaces: new terminal, agent, files, browser, tasks, "Open file…", and "Attach to running" sessions not shown in any window. New terminals and agents start in the focused window's directory.

- **Phone launcher**: a bottom sheet with a grid of window kinds.
- **Phone overview**: a sheet with workspace chips, the current workspace's windows, and running sessions that no window shows (minimized). Tap focuses or attaches, drag reorders, swipe left closes (with Undo). Sheets close by dragging down anywhere on them.
- **Desktop command palette** (`Alt O`): fuzzy search over windows, new windows, running sessions, tasks and commands.
- **Settings** is a dialog on every screen size, opened from the bottom bar (phone), the top bar or the command palette. Its one-time server setup actions close the dialog and open a terminal window running the displayed command (`sudo -iu romp gh auth login`, `sudo -iu romp omp setup`); the window's Restart runs it again.

## Keyboard shortcuts

All shortcuts use Alt and match on physical keys (`e.code`), so macOS Option works. Terminals pass these chords to the shell instead of the program running in it; every other Alt chord goes to the terminal.

| Action | Keys |
|---|---|
| Focus left / right (up / down in tile mode) | Alt ←/→ (↑/↓) |
| Move window left / right | Alt Shift ←/→ |
| Cycle width preset / toggle full width | Alt R / Alt M |
| Resize split (tile) | Alt Ctrl arrows |
| Launcher / command palette | Alt O |
| New terminal here / close window | Alt Enter / Alt W |
| Toggle scroll / tile | Alt T |
| Switch to / move window to workspace 1 to 9 | Alt 1…9 / Alt Shift 1…9 |
| Previous / next workspace | Alt [ / Alt ] |
| Shortcut list | Alt Shift / |

## Panes

Every pane uses a skeleton while loading, an empty state with one next action, and a banner for connection problems and errors.

- **Terminal**: xterm.js themed from the tokens. On touch screens an extra-keys row (Esc, Tab, Ctrl, Alt, Select, Paste, arrows, common symbols) sits above the keyboard; Ctrl and Alt latch for one key on tap and lock on double tap. Select (or a long-press on the terminal) freezes the scrollback into a plain-text layer that takes the system's own text selection and Copy menu, and swaps the row for Copy / Select all / Paste / Done; copies rejoin soft-wrapped lines. Paste reads the clipboard through `navigator.clipboard`, which needs the HTTPS origin. Reconnecting replays scrollback.
- **Files**: breadcrumbs plus a list, folders first. Create, rename, and trash with Undo (trash is restorable from `~/.local/share/romp/trash`).
- **Editor**: CodeMirror 6 with language by file extension, line wrapping on phones, autosave. If the file changed on disk since it was opened, saving stops and a banner offers "Keep mine" (overwrite) or "Load disk version".
- **Agent**: messages with markdown, collapsible thinking, and tool cards (bash, edit with diff, read, write, search…) that stream live progress. The view sticks to the bottom unless you scroll up. While the agent is working, the composer sends either a steer (now) or a follow-up (after this turn), and shows Stop. Agent questions render as inline cards (select, confirm, text, editor) with their timeout.
- **Browser**: address field plus a picker of listening ports; local ports load through `/proxy/<port>/` in an iframe.
- **Tasks**: repos with their tasks grouped by what needs attention (needs attention, in progress, shipping, landed). Each row shows a status chip, ahead/behind counts, a dirty dot and one primary action. Ship holds the request for 5 seconds with Undo, because a push to `main` can't be taken back. Each repo has a push / PR landing toggle; failed landings show the log tail.

## Status colors

| State | Token |
|---|---|
| Task active / conflict / queued / landing / landed / failed | `--task-*`: accent, warning, muted, violet, success, danger |
| Connection live / connecting, reconnecting / offline, exited | `--conn-*`: success, warning, subtle |
