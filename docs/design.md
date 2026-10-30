# ROMP web shell design spec

Source: designer consult. Implementation reference for packages/web.

## Direction
- Build a dark-first, dense developer-tool look in a new `packages/web` package (`@romp/web`, the filter used by `ROMP/package.json` `dev:web`). There is no in-repo reference surface. The only grounding is the wire contract in `ROMP/packages/protocol/src/index.ts`, so every status, count and state below is tied to a protocol field rather than made up.
- One frame with two breakpoints. Phones get a carousel of full-width columns plus a bottom bar, with buttons in thumb reach and `+` far right. Tablet and desktop get a 40px top bar with workspace tabs, a column minimap, the mode switch, the launcher and an avatar. Layout is sized from `visualViewport` (`--vvh`), so the on-screen keyboard never covers the terminal extra-keys row or the composer.
- The same window chrome is used in scroll and tile mode: kind icon, title, client count, connection dot, then the window's own status badge (busy, needs input, save status). Focus shows as an accent border plus a brighter title bar. Scroll mode resizes with four width presets shown as small width diagrams. Tile mode resizes with split handles you drag.
- Every live pane uses one shared set of connection states (`connecting`, `live`, `reconnecting`, `offline`, `exited`) and one `Banner` component. Any text the user typed stays when they go offline or a request fails.
- Tasks are grouped by repo, then by what needs the user's attention: Needs attention, In progress, Shipping, Landed. Each row shows its status chip, ahead/behind counts, dirty dot and one primary action. Ship holds the POST for 5 seconds with Undo, because a push to main cannot be taken back and the API has no way to cancel a ship.
- One icon set (`@lucide/svelte`, behind a local registry), self-hosted Inter Variable and JetBrains Mono Variable from `@fontsource-variable`, OKLCH tokens with relative-color variants, and native `<dialog>` for modals.

## Implementation prompt
```
Build the ROMP web shell UI foundation and all six panes. Greenfield: no UI exists. Data shapes come only from
ROMP/packages/protocol/src/index.ts (cited below as P). Root scripts: ROMP/package.json:6-11 (dev:web, build, check, test).

0. PACKAGE
- Create ROMP/packages/web as "@romp/web" (name must match `pnpm --filter @romp/web` in package.json:7).
  Svelte 5 runes + Vite SPA, scripts: dev, build, check (svelte-check), test.
  UNVERIFIED: ROMP/pnpm-workspace.yaml already globs packages/* (25 B file, not read). Confirm it does.
- Deps: @lucide/svelte, @fontsource-variable/inter, @fontsource-variable/jetbrains-mono, @floating-ui/dom,
  @xterm/xterm + @xterm/addon-fit, codemirror 6 packages, marked + dompurify (agent markdown).
- Import fonts once in src/main.ts: `import "@fontsource-variable/inter"; import "@fontsource-variable/jetbrains-mono";`
  Never import a font in a component. No third-party CSS or font URLs.
- index.html: <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">,
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">,
  <meta name="theme-color" media="(prefers-color-scheme: dark)"> and a light twin. Manifest: display "standalone".
  Manifest and meta colors cannot use CSS vars: copy the literal --bg value from tokens.css and put a comment next to each copy naming the token.

1. src/styles/tokens.css: the ONLY file that holds literal values
:root { color-scheme: dark light; }
Dark (default, :root):
  --bg: oklch(0.16 0.008 255)          app background, gaps between panes
  --surface-1: oklch(0.19 0.009 255)   pane body, terminal and editor background
  --surface-2: oklch(0.225 0.011 255)  title bars, top/bottom bar, cards, user message
  --surface-3: oklch(0.265 0.013 255)  hover, pressed, menus, active tab
  --inset: oklch(0.14 0.008 255)       code and tool-output wells, landing log
  --line: oklch(0.30 0.012 255)        --line-strong: oklch(0.40 0.016 255)
  --border: 1px solid var(--line)
  --fg: oklch(0.94 0.006 255)  --fg-muted: oklch(0.74 0.012 255)  --fg-subtle: oklch(0.58 0.014 255)
  --accent: oklch(0.72 0.14 245)  --accent-fg: oklch(0.16 0.03 245)
  --success: oklch(0.75 0.15 152)  --warning: oklch(0.81 0.14 78)  --danger: oklch(0.69 0.18 25)
  --info: oklch(0.74 0.12 210)  --violet: oklch(0.72 0.14 300)
  --overlay: oklch(0.10 0.01 255 / 0.6)
  --shadow-sm: 0 1px 2px oklch(0 0 0 / 0.25)  --shadow-md: 0 4px 16px oklch(0 0 0 / 0.30)  --shadow-lg: 0 12px 40px oklch(0 0 0 / 0.40)
  --ansi-black: oklch(0.30 0.01 255)  --ansi-red: oklch(0.68 0.17 25)  --ansi-green: oklch(0.74 0.14 150)
  --ansi-yellow: oklch(0.80 0.13 85)  --ansi-blue: oklch(0.70 0.13 250)  --ansi-magenta: oklch(0.72 0.14 320)
  --ansi-cyan: oklch(0.76 0.11 200)  --ansi-white: oklch(0.86 0.01 255)
@media (prefers-color-scheme: light) { :root { color-scheme: light;
  --bg: oklch(0.975 0.003 255) --surface-1: oklch(1 0 0) --surface-2: oklch(0.965 0.004 255) --surface-3: oklch(0.93 0.006 255)
  --inset: oklch(0.955 0.004 255) --line: oklch(0.89 0.006 255) --line-strong: oklch(0.80 0.01 255)
  --fg: oklch(0.22 0.01 255) --fg-muted: oklch(0.45 0.012 255) --fg-subtle: oklch(0.58 0.012 255)
  --accent: oklch(0.55 0.17 250) --accent-fg: oklch(0.99 0 0)
  --success: oklch(0.55 0.15 150) --warning: oklch(0.62 0.14 70) --danger: oklch(0.56 0.20 25)
  --info: oklch(0.55 0.12 220) --violet: oklch(0.52 0.17 300) --overlay: oklch(0.20 0.01 255 / 0.35)
  shadows: same offsets, alpha 0.08 / 0.12 / 0.18
  --ansi-*: black 0.30 0.01 255, red 0.52 0.19 25, green 0.52 0.14 150, yellow 0.58 0.13 80, blue 0.50 0.16 255,
            magenta 0.52 0.17 320, cyan 0.54 0.11 200, white 0.80 0.01 255 (all oklch) } }
Derived (declare once, theme-independent):
  --accent-soft: oklch(from var(--accent) l c h / 0.16), and the same /0.16 rule for --success-soft, --warning-soft,
  --danger-soft, --violet-soft, --info-soft
  --ansi-bright-<name>: oklch(from var(--ansi-<name>) calc(l + 0.08) c h) for all 8
Semantic mapping (components use ONLY these for status):
  task (TaskStatus, P "TaskStatus"):
    --task-active: var(--accent)   --task-conflict: var(--warning)  --task-queued: var(--fg-muted)
    --task-landing: var(--violet)  --task-landed: var(--success)    --task-failed: var(--danger)
  connection:
    --conn-live: var(--success)  --conn-connecting: var(--warning)  --conn-reconnecting: var(--warning)
    --conn-offline: var(--fg-subtle)  --conn-exited: var(--fg-subtle) (nonzero exit code uses --danger)
Spacing (4pt): --sp-1: 0.25rem --sp-2: 0.5rem --sp-3: 0.75rem --sp-4: 1rem --sp-6: 1.5rem --sp-8: 2rem
Radii: --radius-sm: 4px (chips, kbd) --radius-md: 6px (buttons, inputs, panes) --radius-lg: 10px (menus, cards, dialogs)
       --radius-xl: 14px (sheet top corners) --radius-full: 999px
Type: --font-ui: "Inter Variable", system-ui, -apple-system, "Segoe UI", sans-serif
      --font-mono: "JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, Consolas, monospace
      --text-xs: 0.75rem  --text-sm: 0.8125rem  --text-md: 0.875rem  --text-lg: 1rem  --text-xl: 1.25rem
      --term-font-size: 13px; on (max-width: 639px) 12px. xterm reads this number.
Motion: --dur-fast: 60ms (hover)  --dur: 150ms (state)  --dur-enter: 220ms  --dur-exit: 160ms  --ease: cubic-bezier(0.2, 0, 0, 1)
        @media (prefers-reduced-motion: reduce) { --dur-enter: 0ms; --dur-exit: 0ms }
Sizes: --topbar-h: 2.5rem  --bottombar-h: 3.5rem  --titlebar-h: 2rem  --toolbar-h: 2.25rem  --row-h: 2.25rem
       --tap: 2.75rem  --extrakeys-h: 2.75rem  --pane-gap: 0.25rem  --split-hit: 0.5rem
       @media (pointer: coarse) { --titlebar-h: 2.75rem; --toolbar-h: 2.75rem; --row-h: 2.75rem; --topbar-h: 2.75rem; --split-hit: 1rem }
       --palette-w: 40rem  --dialog-w: 28rem  --menu-min-w: 12rem  --toast-w: 22rem  --chat-measure: 48rem  --sheet-max-h: 85dvh
       --safe-top/right/bottom/left: env(safe-area-inset-*, 0px)
       --vvh: 100dvh; --vv-top: 0px; --kb-inset: 0px   (defaults; overwritten by viewport.svelte.ts)
Layers: --z-pane: 1 --z-pane-focused: 2 --z-split: 10 --z-banner: 20 --z-bar: 100 --z-popover: 200
        --z-sheet: 300 --z-dialog: 400 --z-toast: 500 --z-tooltip: 600

2. src/styles/global.css
- Reset, box-sizing border-box, body font var(--font-ui) var(--text-md)/1.43, color var(--fg), bg var(--bg).
  On (pointer: coarse) the body uses --text-lg/1.5 for prose. inputs/textarea/select ALWAYS font-size: 1rem on coarse (stops iOS zoom-on-focus).
- Headings: h1 var(--text-xl)/1.75rem 600, h2 var(--text-lg)/1.5rem 600, h3 var(--text-md)/1.25rem 600, h4 var(--text-sm) 600.
  text-wrap: balance on h1-h4, pretty on p. Components never set a heading font-size.
- Utilities: .muted (--fg-muted), .subtle (--fg-subtle), .meta (--text-xs, --fg-muted), .mono (--font-mono),
  .tabular (font-variant-numeric: tabular-nums), .truncate (one line, ellipsis), .sr-only.
- Buttons (base): min-height calc(1lh + var(--sp-2)*2 + 2px), padding 0 var(--sp-3), radius --radius-md,
  transition background var(--dur-fast), border-color var(--dur). Variants via data-variant:
  primary (bg --accent, color --accent-fg), secondary (bg --surface-2, border --border), ghost (transparent, --fg-muted),
  danger (color --danger, border 1px solid currentColor).
  :hover bg oklch(from <base> calc(l + 0.04) c h) (light theme: calc(l - 0.04)), :active calc(l - 0.03),
  [disabled] opacity 0.6 + cursor not-allowed. On coarse pointers min-height var(--tap).
- Focus: buttons/links/[role=tab]/rows: outline 0 solid color-mix(in srgb, var(--accent) 60%, transparent);
  :focus-visible outline-width 2px, outline-offset 1px. Inputs: :focus border-color var(--accent).
- Inputs: bg --surface-1, border --border, radius --radius-md, padding var(--sp-2) var(--sp-3).
  input:user-invalid, [aria-invalid="true"] → border-color var(--danger). .field-error → --text-xs, color --danger, margin-top --sp-1.
  Never style :invalid.
- kbd: --font-mono --text-xs, padding 0 var(--sp-1), border --border, radius --radius-sm, --fg-muted.
- .skeleton: bg --surface-2, radius --radius-sm; shimmer = linear-gradient sweep of --surface-3 over 1.2s, only inside
  @media (prefers-reduced-motion: no-preference).
- :target { scroll-margin-block: 5ex }.

3. src/lib/icons.ts: the single icon registry
Re-export from @lucide/svelte under semantic names. Nothing else imports lucide directly. (Names are from lucide; the TS import fails if one is wrong.)
  kind: terminal=SquareTerminal, files=FolderTree, editor=FileCode, agent=Bot, browser=Globe, tasks=GitBranch
  KIND_ICON: Record<WindowKind, Component> (WindowKind, P "WindowKind")
  ui: Close=X, Add=Plus, Overview=Layers, ModeScroll=GalleryHorizontalEnd, ModeTile=LayoutGrid, Clients=Users,
      Spinner=LoaderCircle, Check, Success=CircleCheck, Fail=CircleX, Warn=TriangleAlert, Queued=Clock, Active=CircleDot,
      Ahead=ArrowUp, Behind=ArrowDown, Stop=Square, Send=ArrowUp, Thinking=Brain, Tool=Wrench, ToolEdit=FilePen,
      ToolRead=FileText, ToolWrite=FilePlus, ToolSearch=Search, Folder, File, FileImage, FolderPlus, FilePlus,
      More=Ellipsis, External=ExternalLink, Reload=RotateCw, ChevronRight, ChevronDown, ChevronUp, Trash=Trash2,
      Rename=Pencil, Undo=Undo2, LandPush=GitMerge, LandPr=GitPullRequest, Ship=Rocket, Offline=WifiOff,
      HideKeyboard=KeyboardOff, Copy, JumpLatest=ArrowDownToLine, Grip=GripVertical, Shortcuts=Command
Icons are 16px in chrome and rows, 14px in meta, and 20px in bottom bar and launcher tiles. They inherit currentColor.

4. src/lib/ui/: shared primitives (build these first; panes compose them)
- Button.svelte: props variant 'primary'|'secondary'|'ghost'|'danger', size 'sm'|'md', icon?, disabled. Fires on click only.
- IconButton.svelte: required `label` prop → aria-label + tooltip. Square, var(--titlebar-h) sized inside title bars and var(--tap) on coarse.
- AsyncButton.svelte: takes an `action: () => Promise` prop. Shows Spinner + optional `pendingLabel` while pending, disables itself, and rethrows to the caller.
- tooltip.ts: Svelte action `use:tooltip` that reads aria-label. 600ms warm-up, 300ms skip window for instant neighbors,
  shows on hover and keyboard focus, never on touch. Panel: --surface-3, --text-xs, --radius-sm, --shadow-md, --z-tooltip.
- Popover.svelte + Menu.svelte/MenuItem.svelte: one floating mechanism built on @floating-ui/dom
  (computePosition + flip + shift + autoUpdate). Portals to document.body, or to the nearest open <dialog> when the trigger is inside one.
  Dismisses on outside pointerdown and on Escape (Escape closes the menu only, not the dialog under it). Menu triggers open on pointerdown.
  Items commit on click. Arrow keys move, Enter picks. Panel: --surface-2, --border, --radius-lg, --shadow-md, min-width --menu-min-w, --z-popover.
  No submenus anywhere (flat sections with a .meta header instead).
- Dialog.svelte: native <dialog> + showModal(), backdrop --overlay, width min(--dialog-w, 100vw - 2*--sp-4), --radius-lg, --shadow-lg.
  Title h2, body, footer with actions at right (secondary then primary).
- Sheet.svelte: <dialog> anchored to the bottom, full width, max-height --sheet-max-h, top radius --radius-xl, padding-bottom
  calc(var(--sp-4) + var(--safe-bottom)). 32x4px grip in --line-strong. Drag down follows the finger; past 30% of height or a fast
  fling, release dismisses, otherwise it springs back (--dur-enter). Enter is translateY 100%→0 over --dur-enter.
- Toaster.svelte + toast.svelte.ts: toast({message, action?: {label, run}, tone?}). role=status. Max 3, 5s (8s with an action),
  hover/focus pauses. Phone: bottom center at bottom: calc(--bottombar-h + --safe-bottom + --sp-2). Desktop: bottom-right
  --sp-4 inset, width --toast-w. --surface-3, --shadow-md, --z-toast. Error toasts carry a 2px inline-start border in --danger.
  ApiError.message (P "ApiError") is shown as-is.
- Banner.svelte: in-pane strip at the top of a pane body. Props tone 'info'|'warning'|'danger'|'neutral', icon, text, actions snippet.
  bg --surface-2, border-block-end --border, 2px inline-start border var(--<tone>), padding --sp-2 --sp-3. Text left, actions right.
- Chip.svelte: --text-xs 500, padding 0 --sp-2, height 1.25rem, radius --radius-full, color var(--tone), bg oklch(from var(--tone) l c h / 0.16), icon 12px.
- TaskStatusChip.svelte: TaskStatus → {label, icon, tone}: active "Active" Active --task-active; conflict "Conflict" Warn
  --task-conflict; queued "Queued" Queued --task-queued; landing "Landing" Spinner (spins; static under reduced motion)
  --task-landing; landed "Landed" Success --task-landed; failed "Failed" Fail --task-failed.
- ConnDot.svelte: 8px circle. live = filled --conn-live; connecting/reconnecting = filled --conn-reconnecting with a 1.2s opacity
  pulse (no-preference only); offline = 1.5px ring in --conn-offline; exited = filled --conn-exited, or --danger when exitCode ≠ 0.
  aria-label + tooltip "Live" | "Connecting…" | "Reconnecting…" | "Offline" | "Exited (code N)".
- ClientCount.svelte: renders only when clients > 1: Clients icon 14px + number .tabular .meta, tooltip "N clients attached".
- Segmented.svelte: radiogroup, 2-4 options with icon+label, active option --surface-3 + --fg, others --fg-muted.
- Skeleton.svelte (lines|rows|blocks presets), EmptyState.svelte (icon 24px subtle, h3 title, .muted line, actions; centered),
  Spinner.svelte, Avatar.svelte (img from Me.avatarUrl, else initials of Me.displayName on --accent-soft; sizes 20/24/40).
- conn/socket.svelte.ts: reconnecting WebSocket exposing `state: 'connecting'|'live'|'reconnecting'|'offline'|'exited'` and `attempt`.
  Backoff 0.5, 1, 2, 4, 8s, capped at 10s. Reconnects immediately on visibilitychange→visible and on `online`. Goes offline when navigator.onLine is false.

5. src/lib/shell/viewport.svelte.ts
- On visualViewport resize/scroll (rAF-throttled) set on <html>: --vvh = vv.height px, --vv-top = vv.offsetTop px,
  --kb-inset = max(0, innerHeight - vv.height - vv.offsetTop) px. Export rune `keyboardOpen` = kb-inset > 80.
- App root: position fixed; inset-inline 0; top var(--vv-top); height var(--vvh); overflow hidden. html/body overflow hidden.
- Export `layout` rune: 'phone' (max-width: 639px) | 'tablet' (640–1023px) | 'desktop' (≥1024px), plus `coarse` = (pointer: coarse).
- Default mode for a NEW workspace: desktop → 'tile', otherwise 'scroll'. Stored Workspace.mode (P "Workspace") is always respected.

6. src/lib/shell/AppFrame.svelte (+ TopBar, BottomBar)
Phone (layout = phone):
  [ active workspace content: fills the height ]
  [ BottomBar: height calc(--bottombar-h + --safe-bottom), padding-bottom --safe-bottom, bg --surface-2, border-block-start --border, --z-bar ]
    left → right, items spaced between, each a --tap target:
    WorkspaceButton (workspace name .truncate max 8rem + ChevronUp; opens a Menu upward: workspaces with window count right-aligned
      .tabular, "New workspace", "Rename…") | OverviewButton (Overview icon + "2/4" .tabular = focused index / window count;
      a 6px --warning dot when any window needs input) | ModeToggle (ModeScroll or ModeTile for the CURRENT mode; aria-label
      "Layout: scroll. Switch to tile") | LauncherButton (Add, primary filled 2.75rem circle, the only filled control in the bar)
  When keyboardOpen: hide BottomBar (display none) so the focused pane gets the full --vvh.
  No top bar on phone. The first row of each column (its TitleBar) gets padding-top var(--safe-top).
Tablet/desktop:
  [ TopBar: height --topbar-h + --safe-top, bg --surface-2, border-block-end --border ]
    left: WorkspaceTabs: tab = "<n> <name>" (n .meta .tabular), height 1.75rem, active tab --surface-3 + --fg, others ghost --fg-muted.
          Click switches, double-click renames inline (switching is still correct, so no click delay), trailing Add IconButton "New workspace".
    center: StripMap (scroll mode only): one rect per window, height 12px, width = window.width × 40px, gap 2px, radius 2px;
          focused rect --accent, others --line-strong, outline bracket (1px --fg-muted) around the visible range. Click focuses.
          Each rect has aria-label = window title and a tooltip.
    right: gateway-offline Chip (Offline icon, tone --warning, "Offline") shown only when /api fails or navigator.onLine is false |
          Segmented mode switch [ModeScroll "Scroll" | ModeTile "Tile"] | Button secondary "New window" + <kbd>Alt O</kbd> |
          Avatar 24 (Me, P "Me") with tooltip "<displayName> · <user>@<host>".
  Content area below with padding var(--pane-gap). No bottom bar.

7. Window chrome: src/lib/shell/WindowFrame.svelte + TitleBar.svelte
- Pane: bg --surface-1, border --border, radius --radius-md, overflow hidden, z --z-pane. Focused: border-color var(--accent),
  title bar bg --surface-2 and title --fg. Unfocused: title bar --surface-1 and title --fg-muted. Transition --dur. Focus follows
  pointerdown anywhere in the pane and the WM shortcuts. Phone scroll mode: no border/radius, since each column fills the screen.
- TitleBar (height --titlebar-h, padding-inline --sp-2, gap --sp-2, border-block-end --border):
  left: KIND_ICON[kind] 16px | title .truncate --text-sm 500 (terminal: WindowState.title or cwd basename; files: path basename;
        editor: filename + 6px --fg-muted dot when unsaved; agent: AgentInfo.title; browser: ":<port>" or URL host; tasks: "Tasks")
  right, in this order: per-pane badge slot (agent: Chip --warning "Needs input" or Spinner 14px "Working";
        editor: SaveStatus) | ClientCount (terminal, agent; TermInfo.clients / AgentInfo.clients, P "TermInfo", "AgentInfo") |
        ConnDot (terminal, agent only) | WidthPresetButton (scroll mode, tablet/desktop only) | More IconButton "Window actions" |
        Close IconButton "Close window" (tablet/desktop; phone has close in More and Overview)
  More menu: Rename · Move left · Move right · section "Move to workspace" (flat list) · Close window ·
        terminal: "Kill process" (danger, Dialog: "Kill this terminal? Running programs stop and scrollback is lost." [Cancel] [Kill]) ·
        agent: "End session" (danger, same dialog pattern).
  Close window only detaches; it never kills the session. Then toast "Closed <title>" with Undo, which restores the same WindowState at the same index.
- Scroll mode (ScrollStrip.svelte): flex row, gap --pane-gap, overflow-x auto.
  Tablet/desktop: column width = calc((100% - (k-1)*gap) * window.width) where window.width is in {1/3, 1/2, 2/3, 1}
  (P "Workspace": width fraction). No scroll-snap. Focusing a column runs scrollIntoView({inline: 'nearest', behavior}).
  Phone: every column is 100% wide regardless of stored width (do NOT rewrite the stored width; other devices use it).
  scroll-snap-type x mandatory, children scroll-snap-align start + scroll-snap-stop always. The settled column sets focusedId.
  Horizontal swipes in pane bodies move the carousel. Editor uses lineWrapping on phone so it never scrolls sideways. The
  browser iframe captures touches, so swiping works only on its title bar and toolbar.
  WidthPresetButton opens a Menu of 4 items, each a miniature (32×14 box in --line, inner fill in --accent at 33/50/67/100%)
  + label "One third" / "Half" / "Two thirds" / "Full". The button itself shows the miniature of the current width.
- Tile mode (TileView.svelte → recursive TileSplit.svelte over TileNode, P "TileNode"): flex row/column per split,
  first child flex-basis ratio×100%. SplitHandle.svelte between children: hit area --split-hit (cursor col-resize/row-resize,
  z --z-split, touch-action none). Visible 1px line in --line, which turns --accent while hovered or dragged. On coarse pointers also
  a 4×24px grip pill in --line-strong at the center. Pointer drag sets the ratio live, clamped 0.15–0.85, and persists on release.
  Double-click resets to 0.5. Keyboard: focus the handle, ←/→ or ↑/↓ by 0.05. Minimum pane 120px.
- Persist layout: PUT /api/state (P "ShellState") debounced 500ms after any change. GET on load and on visibilitychange→visible.

8. Launcher, overview, palette (src/lib/shell/launcherItems.ts feeds all three)
- Items: New Terminal, New Agent, Files, Browser, Tasks, "Open file…" (path input → editor). New terminal/agent use the cwd of the focused
  window, or Me.home, shown as a mono .meta chip ("in ~/romp/app/fix-login") that opens a path input.
  "Attach to running": GET /api/terms and /api/agents entries not open in any window, showing kind icon, title, cwd .meta,
  ClientCount, and for agents a "Working" spinner when busy.
- Phone LauncherSheet (Sheet): 3×2 grid of kind tiles (min-height 4.5rem, icon 20px over label --text-sm, bg --surface-2,
  radius --radius-lg), then an h4 "Running sessions" list (rows --row-h). Empty list: omit the section.
- Phone Overview (Sheet, full height): a horizontal workspace chip strip (scroll-snap proximity, scroll-padding-inline --sp-2, trailing Add),
  then the current workspace's windows as a vertical list. Each row is 4rem: Grip handle (drag reorders), kind icon, title + .meta subtitle (cwd/path),
  badges right (Needs input, Working, ConnDot, ClientCount). Tap focuses + closes the sheet. Swipe left reveals a --danger "Close" area;
  releasing past 40% closes the window (with Undo toast), short of that it springs back.
- Desktop CommandPalette (Dialog at top: 20vh, width --palette-w): input placeholder "Open a window, switch, or run a command",
  sections Windows (all workspaces; workspace name right-aligned .meta) · New · Running sessions · Tasks (open the task's agent) ·
  Commands (Toggle layout mode, Rename workspace, Width: One third/Half/Two thirds/Full, Keyboard shortcuts).
  Fuzzy match, ↑/↓ moves, Enter runs, Esc closes. No results: "No matches for "<q>"" plus a "New terminal in <cwd>" row.
- Shortcuts (src/lib/shell/keyboard.ts). Match on e.code + altKey (macOS Option produces characters, so e.key is useless). Register in
  the capture phase. The xterm attachCustomKeyEventHandler returns false for these chords so the shell never sees them. Every other Alt chord passes through:
  Alt+←/→ focus column/pane left/right · Alt+↑/↓ focus pane up/down (tile) · Alt+Shift+←/→ move window left/right ·
  Alt+R cycle width preset · Alt+M toggle full width ↔ previous · Alt+Ctrl+←/→/↑/↓ resize the focused split by 0.05 (tile) ·
  Alt+O launcher/palette · Alt+Enter new terminal in the focused cwd · Alt+W close window · Alt+T toggle scroll/tile ·
  Alt+1…9 switch workspace · Alt+Shift+1…9 move window to workspace · Alt+[ / Alt+] previous/next workspace ·
  Alt+Shift+/ ShortcutSheet (Dialog, two-column table: action left, kbd right).

9. Panes (src/lib/panes/*). Every pane uses Skeleton for loading, EmptyState for empty, Banner for connection/error.
TERMINAL (TerminalPane.svelte, ExtraKeys.svelte): TermServerMsg/TermClientMsg, P "TermServerMsg"
- Body: xterm with 4px (--sp-1) padding. Theme built by lib/theme.ts: resolve each token (--surface-1 bg, --fg fg, --accent cursor,
  --accent-soft selection, --ansi-*, --ansi-bright-*) to rgba by painting it into a 1×1 canvas and reading getImageData
  (xterm does not accept oklch). Rebuild on prefers-color-scheme change. fontFamily var(--font-mono), fontSize --term-font-size.
- On every `replay`: term.reset() then write. Send `resize` after fit.
- States: connecting (before replay) → Skeleton 3 mono lines, after 1s add the .muted line "Connecting to terminal…".
  reconnecting → keep the screen, Banner warning "Reconnecting… (attempt N). Input is paused." [Retry now], keyboard input dropped.
  offline → Banner neutral "You're offline. The terminal keeps running on <host> and reconnects when you're back."
  exited → Banner neutral (danger if code ≠ 0) "Process exited (code N)." [Restart] (POST /api/terms with the same cwd) [Close window].
  create failed → EmptyState "Couldn't start a terminal" + ApiError.message + [Retry].
- ExtraKeys: render when coarse AND this terminal is focused. It is a flex row at the bottom of the pane body (above the keyboard, since the
  pane fills --vvh), height --extrakeys-h, bg --surface-2, border-block-start --border, overflow-x auto, scroll-snap proximity.
  Keys in order: Esc · Tab · Ctrl · Alt · ← · ↑ · ↓ · → · | · ~ · / · - · HideKeyboard (aria-label "Hide keyboard", blurs xterm).
  Each key min-width 2.75rem, --font-mono --text-sm, radius --radius-sm, gap --sp-1.
  preventDefault on pointerdown (keeps xterm focused, keyboard stays up); the key fires on click.
  Ctrl/Alt: tap = latch for the next key (aria-pressed, bg --accent-soft, color --accent), double-tap = lock, tap again to release.
  Arrows: holding ≥400ms repeats every 50ms until release. A short tap fires once on click.
  Sequences: Esc \x1b, Tab \t, arrows \x1b[A..D (Alt prefix \x1b, Ctrl+letter → charCode & 0x1f).
FILES (FilesPane.svelte, Breadcrumbs.svelte, FileRow.svelte): FsList/FsEntry/FsOpRequest, P "FsList", "FsOpRequest"
- Toolbar (height --toolbar-h, border-block-end --border): Breadcrumbs left (segments as ghost buttons separated by ChevronRight 12px,
  last segment --fg 500, scrolls horizontally, kept scrolled to the end), actions right: FilePlus "New file", FolderPlus "New folder".
- Rows (--row-h, padding-inline --sp-3, a :not(:last-child) divider is not needed; use hover bg --surface-3):
  icon (Folder for dir, FileImage for png/jpg/gif/webp/svg, FileCode for code extensions, File otherwise) + name .truncate left;
  right: size .tabular .meta (dirs blank) and relative mtime .meta ("3h", "2d"), plus More IconButton "File actions" (visible on hover/focus;
  always visible on coarse). Tap a dir to navigate. Tap a file to open an editor window to the right of this one. Images open
  /api/fs/raw in a browser window. Menu: Rename · Move to trash.
- Rename / New: inline input row (required, pattern="[^/]+", .field-error "Names can't contain /"). Enter commits, Esc cancels.
  Optimistic insert/rename. On failure roll back, toast ApiError.message, and leave the input open with the typed value.
- Trash: remove the row at once, toast "Moved <name> to trash" with [Undo] → {op:"restore", trashId}.
- Loading: Skeleton 8 rows. Empty: EmptyState "This folder is empty" [New file] [New folder].
  Error: EmptyState "Can't open <path>" + ApiError.message + [Go to home] (Me.home). Offline: Banner neutral "Offline: showing the last loaded listing."
EDITOR (EditorPane.svelte, SaveStatus.svelte): FsFile/FsWriteRequest/FsWriteConflict, P "FsFile", "FsWriteConflict"
- CodeMirror fills the body. Theme from tokens directly (var() is fine in CM themes): bg --surface-1, gutter --surface-1 + --fg-subtle,
  active line oklch(from var(--surface-2) l c h / 0.6), selection --accent-soft, font --font-mono --text-sm. lineWrapping when layout=phone.
- Autosave 800ms after the last change, on blur, and on visibilitychange→hidden, with expectedMtimeMs = last known mtime.
- SaveStatus (title bar, --text-xs): "Saved" (Check, --fg-subtle) · "Saving…" (Spinner) · "Unsaved" (dot) ·
  "Offline, not saved yet" (--warning) · "Save failed" (--danger, click retries) · "Conflict" (--warning).
- Conflict (409): Banner warning "<name> changed on disk since you opened it." [Keep mine] (rewrite with the new mtimeMs)
  [Load disk version] (replace the doc as ONE transaction so Ctrl+Z restores your text).
- binary or tooLarge: EmptyState "Can't edit <name> here" + "<size> · binary file" / "<size> · larger than 5 MiB" + [Open raw]
  (/api/fs/raw). Images render inline <img> with max-width 100%. Loading: Skeleton lines with a gutter column.
  Not found: EmptyState "<path> no longer exists" [Close window].
AGENT (AgentPane.svelte + MessageList, UserMessage, AssistantMessage, ThinkingBlock, ToolCard, BusyLine, Composer, QuestionCard):
  AgentServerMsg/AgentClientMsg, P "AgentServerMsg", "AgentInfo"
- Structure:
    [ Banner (conn/exit) ]
    [ MessageList: overflow-y auto, flex 1; inner column max-width --chat-measure, margin-inline auto, padding --sp-4, gap --sp-4 ]
    [ JumpToLatest pill (when scrolled up > 48px): centered above the composer, --surface-3, --shadow-md, JumpLatest icon + "Latest" ]
    [ QuestionCard(s) for pendingUi ]
    [ Composer ]
- UserMessage: right-aligned block, max-width 85%, bg --surface-2, radius --radius-lg, padding --sp-2 --sp-3. Queued steer/follow-up
  shows a .meta "Queued: steer" / "Queued: after this turn" under it.
- AssistantMessage: no bubble, full width, markdown (marked + dompurify). Code blocks: bg --inset, radius --radius-md, --font-mono
  --text-sm, Copy IconButton "Copy code" top-right (hover/focus; always on coarse). Text streams in from message_update deltas.
- ThinkingBlock: header row ghost button: Thinking icon + "Thinking…" while streaming / "Thought for 12s" when done + ChevronRight
  (rotates 90° when open). While streaming, the body shows the last 3 lines (max-height 3lh, fade-out mask at top) in --fg-subtle.
  Collapsed when done.
- ToolCard: one container (bg --surface-2, --border, --radius-md); no nested cards. Header row (--row-h): tool icon (bash→terminal,
  edit→ToolEdit, read→ToolRead, write→ToolWrite, grep/find/glob→ToolSearch, other→Tool) · tool name --font-mono 600 · one-line
  arg summary (command or path) .truncate --fg-muted · right: Spinner while running | Check (--success) | Fail (--danger), duration .meta .tabular,
  Chevron. Collapsed by default; errored cards start expanded. Expanded: args <pre> and output <pre> on --inset, --font-mono --text-xs,
  max-height 20lh with overflow auto, "Show all N lines" ghost button when clipped. Edit diffs: added lines bg --success-soft,
  removed lines bg --danger-soft, with a +/- gutter. Consecutive tool cards use gap --sp-1.
- BusyLine (AgentInfo.busy): after the last message, 6px --accent dot (pulse only under no-preference) + "Working · 0:42" .tabular +
  " · Running bash" when a tool is active. The TitleBar shows Spinner "Working" at the same time.
- Composer (padding --sp-2 --sp-3 + --safe-bottom when it is the last row on phone, border-block-start --border, bg --surface-2):
  textarea field-sizing content, min-height calc(1lh + var(--sp-2)*2 + 2px), max-height calc(8lh + ...) phone / 12lh desktop,
  placeholder idle "Ask the agent…", busy "Steer the agent…".
  Idle: Send IconButton "Send" (primary, disabled when empty).
  Busy: above the textarea, Segmented [Steer now | After this turn] (state persisted per window; Steer now is the default; sends
  {type:"steer"} or {type:"follow_up"}); Stop IconButton "Stop" (danger variant, {type:"abort"}) and Send.
  Desktop: Enter sends, Shift+Enter newline, Alt+Enter sends as "After this turn", Esc with an empty composer while busy = Stop.
  Phone: Enter = newline, the button sends.
  On send: append the UserMessage optimistically and clear the textarea. If the rpc `response` has success:false, remove the message,
  PUT THE TEXT BACK in the textarea, and toast the error. Offline: keep the text, disable Send, button aria-label "Offline, reconnecting".
- QuestionCard (one per pending extension_ui_request): bg --accent-soft, border 1px solid var(--accent), radius --radius-lg,
  padding --sp-3, h4 question title. select → full-width option buttons (secondary, min-height --tap, text left).
  confirm → [Cancel] secondary + [Confirm] primary, right-aligned. input → text input + [Submit].
  Sends {t:"ui", response}. When another client answers, the matching frame removes the card. While any card is pending, the TitleBar
  shows Chip --warning "Needs input" and the Overview row and OverviewButton dot light up.
- States: connecting → Skeleton blocks (1 right-aligned, 2 full-width). Empty transcript → EmptyState "Start a session"
  "Ask the agent to change something in <cwd>." with the composer focused. reconnecting → Banner warning "Reconnecting… The agent
  keeps working on the server." Composer text kept. On the next snapshot, replace the transcript and keep scroll position unless
  you were pinned to the bottom. exited → Banner neutral/danger "Agent session ended (code N)." [Start new session] (POST /api/agents same cwd).
BROWSER (BrowserPane.svelte, PortPicker.svelte, AddressBar.svelte): ListeningPort P:346-349
- Toolbar (--toolbar-h): PortPicker button (":5173" mono, or Globe for absolute URLs) → Menu rows "process .truncate left · :port
  mono right" + "Refresh list" | Reload IconButton "Reload" | address input (flex 1, --font-mono --text-sm; accepts "5173" → /proxy/5173/,
  "/proxy/…", or an absolute URL) | External IconButton "Open in new tab".
- iframe fills the rest, bg --surface-1. Loading: 2px top progress bar in --accent that eases toward 90% and finishes on iframe load.
- Before setting the src for /proxy/<port>/: fetch(url, {method:"HEAD"}). If 502/connection error → EmptyState "Nothing is listening on :<port>"
  "Start the dev server in a terminal, then retry." [Retry] [Pick another port].
  UNVERIFIED: the gateway returns 502 for a dead proxy port.
- No URL yet: EmptyState "Pick a dev server" listing ports as secondary buttons (":5173 · vite"). No ports: "No dev servers are
  listening. Start one in a terminal, then refresh." [Refresh]. Absolute URL: .meta hint under the toolbar after 8s with no load event:
  "If this stays blank, the site refuses to be embedded. Open it in a new tab."
TASKS (TasksPane.svelte, RepoSection, TaskRow, LandModeToggle, NewTaskComposer, LandingLog, AddRepoDialog):
  RepoInfo, TaskInfo P:295-311, TaskStatus, RepoAdd P:314, RepoSettingsUpdate P:320, TaskCreate P:327, TaskCreated P:335, TaskShip P:340
- Header row: h2 "Repos" left, Button secondary "Add repo" right.
- RepoSection: header row: h3 repo name · remote host .meta mono .truncate · Chip neutral (--fg-muted) branch "main" | right:
  LandModeToggle = Segmented [LandPush "Push to <branch>" | LandPr "Pull request"], saving on change (optimistic PUT settings,
  inline .meta "Saved" fades after 2s, rollback + toast on error) · Button primary sm "New task".
- Group headers inside a repo (h4 + count .meta .tabular), in this order: "Needs attention" (conflict, failed) · "In progress" (active)
  · "Shipping" (queued, landing) · "Landed" (collapsed by default, "Landed (12)" toggles open). Empty groups are not rendered.
- TaskRow (min-height --row-h + --sp-2, two lines, hover --surface-3):
  left: TaskStatusChip · title 500 .truncate, below it branch .meta mono .truncate
  right (edge-locked, .tabular): Ahead 12px + ahead, Behind 12px + behind (hide a zero side), 6px --warning dot when dirty
  (aria-label + tooltip "Uncommitted changes") · primary action · More IconButton "Task actions"
  primary action by status: active → Button primary sm Ship "Ship" (disabled when ahead=0, tooltip "Nothing to ship yet");
    conflict → "Resolve with agent" (opens or attaches the task agent) + .meta second line "<n> conflicted files: a.ts, b.ts…";
    failed → "View log" toggles LandingLog; queued/landing → no button, LandingState.message .meta on the second line;
    landed → pr mode: link "Pull request" + External icon (prUrl); push mode: commit short sha .mono .meta.
  More menu: Open agent · Open terminal here · Open files here · Delete task (danger).
  Delete = Dialog "Delete <title>?" "Removes the worktree and branch <branch>. Unshipped commits are lost." [Cancel] [Delete task].
  It is irreversible, so: AsyncButton, no optimistic update.
- Ship: change the row to Queued at once and toast "Shipping <title> to <branch>" with [Undo] for 5s. The POST /ship goes out only after
  the 5s, and Undo cancels it. If the POST fails: restore the status and toast ApiError.message.
- LandingLog: under the row, bg --inset, radius --radius-md, padding --sp-3, first line LandingState.message 600, then
  <pre> log --font-mono --text-xs max-height 16lh overflow auto, then actions right [Open agent] [Retry ship].
- NewTaskComposer (inline under the repo header when "New task" is pressed; ALWAYS open when the repo has no tasks):
  textarea "What should the agent do?" (required, field-sizing content, 3lh-10lh) · input "Title" prefilled from the first line
  of the prompt (≤60 chars) until the user edits it · [Cancel] ghost + AsyncButton primary "Start task".
  Not optimistic: wait for TaskCreated, with pendingLabel that steps "Creating worktree…" → "Starting agent…" after 2s.
  On success: insert the row and open an agent window for TaskCreated.agent right of the tasks window. On error: keep every field and show
  .field-error with ApiError.message.
- AddRepoDialog: input "Repository URL" (required, type text, placeholder "https://github.com/you/app.git or git@github.com:you/app.git"),
  optional "Name", "Branch" (placeholder "main") · AsyncButton "Add repo", pendingLabel "Cloning…". Error → inline .field-error, inputs kept.
- Data: GET /api/tasks every 3s while any task is queued/landing and the tab is visible, otherwise every 15s, plus immediately on visibility.
  After any mutation, refetch tasks AND repos.
- States: loading → Skeleton header + 4 rows. No repos → EmptyState "Add a repo to start tasks" with the URL field + "Add repo"
  inline (no dialog). Load error → EmptyState "Couldn't load tasks" + ApiError.message + [Retry].

10. Finally run the design-system-init skill to write the project design-system overlay from tokens.css, global.css,
    icons.ts, and src/lib/ui/*.

Do not:
- Put a literal color, size, duration or z-index in any .svelte file. Add it to tokens.css first. Manifest/meta theme-color are the only literal copies.
- Pass oklch strings to xterm or match shortcuts on e.key. Resolve colors through the canvas helper, and match chords on e.code.
- Bind any action to pointerdown (only menu triggers open on press; ExtraKeys use pointerdown only to preventDefault focus loss),
  or add `title=""` tooltips, inline SVG icons, or direct lucide imports outside src/lib/icons.ts.
- Rewrite WindowState.width when the phone forces full-width columns, or clear composer/form text on any failure.

Verify:
- pnpm check && pnpm test && pnpm build (ROMP/package.json:6-11). Then pnpm dev:web.
- Emulate 390x844x1,mobile,touch · 820x1180x2,mobile,touch · 1280x800x1 · 1920x1080x1, in dark AND light (prefers-color-scheme).
- Phone: swipe the carousel across terminal/editor/browser; focus the terminal so ExtraKeys sit right above the keyboard and the bottom bar hides;
  focus the composer and check it isn't covered; open the launcher sheet and drag it shut; swipe a row closed in Overview and Undo.
- Desktop: every shortcut in the map with the terminal focused (the shell must not receive them); drag tile splits; width presets; palette.
- States: kill the gateway mid-session (terminal + agent reconnect banners, composer text kept), devtools Offline, empty folder,
  binary file, 409 editor conflict, browser on a dead port, no repos, failed task with log, pending question answered from a second tab,
  prefers-reduced-motion on (no pulse, shimmer, or sheet slide).

Non-goals:
- Free-form column width dragging in scroll mode (presets only), submenus, user theme settings, merging layout edits from two devices
  (last write wins), diff/merge UI for editor conflicts, hold-to-repeat for keys other than arrows, any sound.
```