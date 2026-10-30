---
name: ui-ux-guide
description: Project-independent UI/UX rules. Use whenever creating, editing, designing, or reviewing any user-facing surface (pages, forms, modals, components, dashboards, dialogs, panels, tables, paywalls, anything that renders). Covers the reuse procedure, token discipline, scannable layout (edge-locked alignment, relative emphasis, container nesting, row differentiation), optimistic-update policy, required button/input states, feedback and wait-time UX, modern CSS (floating panels, anchor positioning, scroll-margin, scroll-snap, `:user-invalid`, `:focus-visible`, the `lh` unit, `field-sizing: content`), rendered-UI verification, dashboard density, behavioral design, paywall structure (one offer, annual default, trial over discount), product loops, premium feel (undo, error recovery, cross-screen consistency, designed failure/offline/empty states, breaking the product on purpose), reading intent (when a click should wait, submenu aim triangles, tooltip warm-up, drag auto-scroll, act-then-undo over confirm modals, autosave, commit on release), and trust around money (looking established, fees shown before payment, irreversible-loss warnings, designed transaction status screens, freeze and hide-balance switches, reachable human support). Pair with the project's `design-system` skill when one exists; it names the tokens, components and commands.
---

# UI/UX guide

These rules hold in every project. The project's own specifics (token names, component library, icon registry, verification commands, dev server) live in its `design-system` skill. Read both before touching UI. When they disagree, the project skill wins, because it describes code that actually exists. Section numbers match between the two skills, so §6 means the same topic in each.

## 0. Procedure (run every time you touch UI)

Do these in order before writing any markup:

1. **Inventory existing components.** List the project's component directory and name the candidates you'll reuse. If something close exists (modal, card, data table, empty state, async button, dropdown, action menu, spinner), reuse it instead of reinventing it.
2. **Inventory existing tokens.** Colors, radii, shadows, widths and z-indexes live in the project's token file. If a value isn't there, find the closest token or add a new one to that file. Never inline a literal in a component.
3. **Pick a canonical reference.** Find the closest existing surface that does something similar and mirror its shape (layout file, data loading, mutation pattern).
4. **State the plan in one or two lines** before editing: components used, tokens used, reference file. Then edit.

Skip 1 to 3 and you will invent duplicate components and styles. A lint hook can block a hex literal. Nothing blocks a second modal, so that part is on you.

## 1. Reuse rules (hard)

- **Components.** Import shared components through the project alias. Never reimplement a modal, card or table because the existing API "almost fits". Extend the component (add a prop) before forking it.
- **Styles.** Nest selectors. Where the framework scopes CSS per component (Svelte, Vue SFCs, CSS modules), use relative selectors (`button { ... }`, `.row > .item`), because redundant class names add noise. Keep class names minimal (`.row`, `.actions`, not `.lead-detail-panel-actions-row`).
- **Icons.** One icon registry per project. No inline SVG icons in pages or ordinary components. Illustrations are drawings, not UI, and may be the exception; the project skill says where they live.
- **Subpage navigation.** Prefer breadcrumbs over a single "Back" link on detail pages and subpages. Breadcrumbs show the full path and the current item. Keep a bare back link for flows whose parent has no stable URL, like a wizard step.
- **People get faces.** Whenever you render a person who belongs to the workspace (list row, table row, detail header, assignee or owner field, comment or activity byline, a picker where one is selected), put an avatar next to their name. Never a bare name string. Show the uploaded photo when there is one and fall back to colored initials. In a selection control the avatar goes in the trigger (current selection) and in each option. Small in dense rows and options, medium in lists, large in detail headers.

## 2. Design tokens (use them, don't invent)

- Every color, radius, shadow, width, z-index and duration comes from a token. No hex, `rgb()` or `hsl()` literal in a component. If a color genuinely doesn't exist yet, add the token first.
- **Never set `z-index` to a magic number.** Use the project's layer scale. If you need a new layer, add it to the scale.
- **Dark mode comes from the tokens.** Don't hardcode a value that has to change with the theme.
- Deriving a one-off variant from a token is fine (§11 relative colors). A near-duplicate literal is not.

## 3. Typography (use existing styles, don't override)

- **Never override `font-size` on a heading.** Use `<h1>` to `<h6>` semantically and let the global ramp size them. Pick the right tag instead.
- One font family, loaded globally, never imported in a component. Prefer a self-hosted font so first paint never waits on a third-party stylesheet.
- For meta text, captions and muted text, use the project's text utilities. If you need a non-heading size that no utility covers, add a utility to the global stylesheet rather than inlining it.
- `text-wrap: balance` on headings and `text-wrap: pretty` on paragraphs belong in global CSS. Don't re-declare them per component, and don't fight them with manual `<br>` or fixed widths.
- **Buttons use sentence case** ("Save changes"). **Titles use title case** ("Lead Details").

## 4. Layout & spacing

Nobody reads a screen top to bottom. A user arrives with one question ("when is this due?", "who owns this?", "what do I owe?") and hunts until they find it, then acts. Layout's job is to make that answer reachable in one scan, not to look tidy. Every rule below serves the hunt.

- **4pt grid.** Spacing values: `0.25rem`, `0.5rem`, `0.75rem`, `1rem`, `1.5rem`, `2rem`. Never `0.3rem`, `0.6rem`, `13px`.
- **Edge-lock, don't center.** Read a receipt: item names flush left, prices flush right, nothing floating in the middle. Do the same for any row that pairs a thing with its value (list item + status, field + amount, name + timestamp, label + count): `display: flex; justify-content: space-between`, or a grid whose trailing column is `text-align: right`. Two hard edges give the eye two reliable scan columns, which is exactly why a receipt needs no dividers, leader dots or boxes. Centered text inside a row or card body destroys both edges and makes the user re-find the start of every line. Center only genuinely standalone content: an empty state, a modal's single confirm action, a marketing hero.
- **Alignment instead of decoration.** When a block reads as unstructured, the fix is almost always alignment, not a divider, border, or extra padding. Line up the left edges, line up the right edges, share a baseline. Add a rule line only when two adjacent groups must be separated and spacing genuinely cannot do it.
- **Hierarchy via size and weight**, not color. Primary actions are larger or filled; secondary ones are smaller or outlined.
- **Emphasis is relative, never absolute.** An element stands out only by contrast with its immediate neighbors. A filled accent button among five other filled buttons is invisible; the same button beside plain text links is unmissable. To emphasize something, demote what surrounds it (sibling actions become ghost or text buttons, sibling weight drops to normal, sibling color drops to the muted text color) rather than piling more weight onto it. One primary emphasis per view: if two things shout, neither does.
- **Whitespace groups.** Related items sit together (small gap); groups are separated (larger gap or divider).
- **Dissolve containers.** A card inside a card inside a panel is borders on borders, and every nesting level costs padding and adds a line to parse. Prefer one container whose internal structure comes from rows and columns: a single border divider between rows, or a column gap, does the job a nested card was doing. Rule of thumb: at most one level of visible container (border, background, or shadow) at a time, and inside it, structure with alignment, spacing, and dividers. A nested card that exists only to group two fields should be deleted and grouped with spacing.
- **Container widths** come from width tokens. Don't pick an arbitrary `max-width: 980px`.

## 5. Optimistic updates (default for all mutations)

Optimistic is the default. The UI shows the result of a mutation immediately, then reconciles with the server. On success real data replaces the placeholder. On failure the placeholder rolls back and the user gets an error (§7).

- Use the framework's built-in optimistic mechanism when it has one; the project skill names it. Don't build a local state mirror with a hand-written rollback, and don't reload the whole page after a mutation when you can refresh the queries it touched.
- Refresh every view that reads the changed data, not only the one the user acted in (§17 Multiplayer).

### When NOT to use optimistic

- **Money-affecting actions** (payments, invoice send, refund): show a deliberate spinner; see §6 reassurance delay.
- **Multi-step flows** where the user waits on confirmation (auth, MFA enrollment).
- **Server-generated IDs the user immediately needs**: the placeholder holds fake data, so if the next interaction depends on the real ID, race conditions follow. Use a real spinner.
- **Irreversible actions** (hard delete, bulk send, anything with no undo): deliberate, behind a confirm step (§19). A soft-deleted item is reversible, so it can disappear at once with an undo toast.

### Forms

Prefer forms that submit without JavaScript and enhance when it loads. Express validation as native constraints first (§11 Validation styling).

## 6. Buttons & inputs: required states

Every interactive element has all four states. Use the project's async button component for async actions; a plain `<button>` is only for instant actions. Global button styles give you the base, so don't reset them.

- **Default**: resting.
- **Hover**: `:hover` change (background, brightness).
- **Active/pressed**: `:active` feedback.
- **Disabled**: `disabled` attribute plus a visible `cursor: not-allowed; opacity: 0.6`.

Inputs additionally need:

- **Focus**: a visible ring, never removed. Buttons, links, triggers, cards and other click targets style `:focus-visible` only, never bare `:focus`, so Tab draws the ring and a mouse click does not (§11 Focus rings). Text inputs, textareas and selects may keep `:focus`, since browsers treat every text-field focus as visible anyway.
- **Error**: danger-colored border, danger-colored text, and a descriptive message below the field.
- **Warning**: warning-colored border for soft issues.

**Validation errors look the same everywhere.** Error styling lives in the global stylesheet, keyed on `:user-invalid` and `aria-invalid="true"`, plus one message class. Express the rule as a native constraint first (`required`, `type="email"`, `pattern`, `min`/`max`, `minlength`) and the border needs no JS at all. For a rule no constraint can express (slug availability, cross-field checks) and for the message text itself:

- Set `aria-invalid="true"` on the input and render the message right below it.
- Gate the JS error on a `touched` flag set on blur (plus a submit attempt), so errors never appear while the user is still typing a first-pass field. That is the timing `:user-invalid` gives native constraints for free.
- Derive the message from validity instead of storing it.
- Local error styles in a component are a smell. Add the rule to the global stylesheet so every form matches.

**Reassurance delay**: critical confirmations (payment submit, "delete account") hold the loading state for at least 1s even if the response is faster, because instant success on a big action feels wrong.

## 7. Feedback (every action gets a response)

- **Toasts** for errors, high-stakes successes, and Undo after an action that ran without a confirm step (§19).
- **Inline confirmation** (e.g. "Saved" near the field) for low-stakes saves.
- **Empty states** carry a clear next action. Never an unexplained blank panel.
- **Loading**: skeleton shimmer that matches the final layout, then spinner, then text, in that order of preference.

## 8. Wait-time UX

- **Predictive load**: start fetching as soon as intent is clear (hover, focus, route prefetch). Request deduplication keeps an early start cheap.
- **Streaming reveal** for AI or generated content, word by word or block by block. It builds trust; instant output feels untrustworthy for generative work.
- **Progress that accelerates**: bias the progress bar so it feels faster near the end.
- **Occupy the wait**: status text that changes ("Connecting…" → "Loading messages…" → "Almost done…") beats a static spinner on waits over 2s.
- **Explain the wait.** An unexplained wait feels longer than an explained one (Maister, 1985). Say why it's waiting and what comes next, and show countable progress as a count ("2 of 8 confirmations") instead of an indeterminate spinner. Money states get their own screens (§20).

## 9. Depth & overlays

- **Shadows sparingly.** The small shadow for cards, the medium one for menus, the large one only for top-of-stack modals. Higher blur with lower opacity reads as subtle.
- **Card depth via a lighter background**, not a bigger shadow.
- **Text over images**: a gradient (`linear-gradient(to top, <overlay token>, transparent)`) or progressive blur. Never a flat black tint, and use overlay tokens, not raw rgba.

## 10. Micro-interactions

- The default transition token (around 150ms) for state changes. Slower (200 to 350ms) for entrance and exit, faster (around 60ms) for hover.
- Confirm actions with motion: a chip slides in, a row briefly highlights in the light accent color, a checkbox checks with a tick animation.
- Don't animate everything. Animate the thing the user just changed.
- Wrap decorative motion in `prefers-reduced-motion: no-preference`, or the project's motion mixin, so reduced-motion users don't get it.
- **Staggered reveal plus hover.** When an element has both a staggered scroll-reveal and `:hover` transitions (a card that fades in and lifts on hover), carry the stagger delay only on the entrance properties. Putting it on `transition-delay`, or on the whole shorthand, delays hover by the entrance delay and makes it feel laggy:
  ```scss
  transition:
    border-color var(--tt) ease-in-out,
    box-shadow var(--tt) ease-in-out,
    transform var(--tt) ease-in-out,
    opacity var(--tt-large) var(--stagger-delay, 0ms) ease-out,
    translate var(--tt-large) var(--stagger-delay, 0ms) ease-out;
  ```

## 11. Modern CSS & HTML (prefer native, high support)

These have broad browser support, so reach for them before JS or extra markup. They cut bundle size, remove layout-shift JS, and stay consistent with the token system.

### Floating panels: one shared mechanism

Every dropdown, listbox, action menu and autocomplete list hangs off its trigger through one shared mechanism: the project's popover utility when it has one. Whatever it is, it must:

- escape clipping ancestors (portal to `<body>` or the top layer)
- place under the anchor, flipping above and clamping to the viewport when it would not fit
- follow the anchor on scroll and resize
- dismiss on outside click and Escape, and cooperate with modals (Escape closes the panel, not the modal underneath)
- keep a submenu open while the pointer travels toward it along the aim triangle (§19)

Never hand-roll `position: absolute` plus a window click listener in a component. Without a shared utility, CSS anchor positioning is the native starting point, with no `getBoundingClientRect` and no scroll listeners:

```scss
button {
  anchor-name: --row-trigger;
}
.menu {
  position: fixed;
  position-anchor: --row-trigger;
  position-area: bottom span-right;
  position-try-fallbacks: flip-block;
}
```

Test it inside a modal before adopting it. The native `popover` attribute renders in the top layer, which puts the panel above an open modal and can change dismissal order.

### Tooltips: labels you can see

Every icon-only button, and every truncated or abbreviated label, has an `aria-label`, and that label is also visible on hover and focus through the project's tooltip mechanism. A bare `aria-label` is invisible to mouse and keyboard users, so pair the two. Add tooltips liberally on icon buttons. An unlabeled icon button, or one whose label never shows, is a defect.

Never use the native `title=""` attribute for this: it is slow to appear, unstyled, invisible to keyboard focus, and useless on touch. Prefer a tooltip that reads its text from `aria-label`, so one string labels the control for screen readers and for sighted users.

### `currentColor`: sync borders and icons to text

`currentColor` resolves to the element's `color`. Use it for borders and SVG strokes or fills that should track the text color, so you don't thread a second token through. Icons that inherit `currentColor` match adjacent text automatically: set `color`, not `fill`.

```scss
.tag {
  color: var(--accent);
  border: 1px solid currentColor;
}
```

This reduces token plumbing; it doesn't replace tokens. The source `color` still comes from a `var(--*)`.

### Relative colors with OKLCH: derive variants from a token

When you need a one-off variant of an existing token (a slightly lighter hover, a faded fill), derive it instead of adding a near-duplicate literal:

```scss
.card:hover {
  background: oklch(from var(--accent) calc(l + 0.05) c h);
}
```

Prefer an existing light/dark variant token when one fits. Derive only when none does, and if you derive the same variant repeatedly, promote it to a real token.

### Fragment jumps: `scroll-margin` on the target

An anchor link (`href="#invoices"`, a docs TOC, a "See how it works" button) scrolls its target flush to the top edge, underneath any sticky header. Offset the target, not the scroll: set `scroll-margin-block-start` on the element the fragment points at. A global `:target { scroll-margin-block: 5ex }` is a good fallback; a surface with a sticky bar sets a larger value on its own anchorable elements, sized from the bar.

```scss
section[id] {
  scroll-margin-block-start: calc(var(--header-height, 3.5rem) + 1rem);
}
```

`scrollIntoView()` honors `scroll-margin` too, so the same rule covers programmatic jumps. Never subtract a header height in JS (`window.scrollTo(top - 64)`). Style the arrival with `:target` (`li:target { color: var(--fg) }`) rather than a class toggled by a hash listener.

### Scroll snapping: `scroll-snap-type` + `scroll-snap-align`

A horizontally scrolling strip (tab bar, filter chips, card carousel) should come to rest on an item edge, not mid-item. The scroll container takes `scroll-snap-type`, each item takes `scroll-snap-align`, and `scroll-padding` keeps the snapped item clear of the container's own padding or a fade mask.

```scss
.strip {
  overflow-x: auto;
  scroll-snap-type: x proximity;
  scroll-padding-inline: 0.5rem;

  > * {
    scroll-snap-align: start;
  }
}
```

- **`proximity`** for tab and chip strips, and for full-width columns the user may want to stop between. It snaps only when the user stops near an edge, so a long fling still lands freely.
- **`mandatory`** only for one-item-per-view carousels, with `scroll-snap-stop: always` so a fast swipe advances one item.
- Skip snapping on a strip whose JS scrolls a child into view with `block/inline: "nearest"`: the snap re-aligns the child to its start edge and fights the script.

### Validation styling: `:user-invalid`, never `:invalid`

`:invalid` matches on first paint, so an empty `required` field is red before the user has typed anything. `:user-invalid` (and `:user-valid`) match only after the user has changed the value and left the field, or tried to submit.

```scss
input:user-invalid {
  border-color: var(--danger);
}
```

Put the constraint in the markup (`required`, `type`, `pattern`, `min`/`max`) and the border follows with no `touched` state. Keep `aria-invalid` plus the message class for the message text and for rules that are not native constraints (§6). Never style bare `:invalid` or `:valid`.

### Focus rings: `:focus-visible`

`:focus-visible` matches when the browser judges the focus should be shown: keyboard navigation, programmatic focus after a key press, and every focus on a text field. A mouse click on a button does not match. Style rings there, and a click never flashes an outline while Tab always shows one.

```scss
.trigger {
  outline: 0 solid color-mix(in srgb, var(--accent) 50%, transparent);

  &:focus-visible {
    outline-width: 3px;
  }
}
```

`outline: none` is allowed only when a `:focus-visible` rule on the same element, or a `:has()` rule on its wrapper, draws a replacement indicator. `&:focus, &:focus-visible` on a button is the old workaround; drop the `:focus` half.

### Line-based sizing: the `lh` unit

`1lh` is the element's own computed line height. Size anything measured in lines with it (a textarea's minimum, a clamped preview, a button's minimum height), so the box follows font-size and line-height changes instead of drifting from a hard-coded `rem`.

```scss
button {
  min-height: calc(1lh + 1rem + 2px); /* one line + block padding + border */
}
.preview {
  max-height: 3lh;
  overflow: hidden;
}
```

Controls use `box-sizing: border-box`, so add the block padding and border to the line count, as above. Never approximate lines with `em` (`min-height: 5em` is neither five lines nor any stable number of them).

### Auto-growing fields: `field-sizing: content`

`field-sizing: content` sizes a textarea (or input) to its value as the user types, with `min-height`/`max-height` as the bounds; past the max it scrolls. Baseline since Firefox 152 (June 2026); an older browser ignores it and shows a normal fixed textarea.

```scss
textarea {
  field-sizing: content;
  min-height: calc(3lh + 1rem + 2px);
  max-height: calc(16lh + 1rem + 2px);
}
```

- `rows` is ignored under `field-sizing: content`. Set the minimum with `min-height`. A one-line field sets `min-height: 1lh` or turns the minimum off, and an inline editor lifts the cap with `max-height: none`.
- Never write a resize script (`style.height = scrollHeight + "px"` on input).

### `:has()`: style a parent from its children

Style a container based on what it contains, with no extra class threaded from JS. Keep selectors relative (§1).

```scss
.card:has(.badge) {
  border-color: var(--accent);
}
```

### `:not()`: exclude from a selector

Drop the special-case override. Instead of bordering every item and then resetting the last, exclude it up front:

```scss
.row:not(:last-child) {
  border-bottom: var(--border);
}
```

Combine with `:has()` for precise targeting (`.list:not(:has(.item))` means empty), though a real empty state should use the empty-state component (§7).

## 12. After editing

1. Run the project's checks once, at the end of the task. The project skill names them.
2. **Look at the rendered UI.** Never claim a surface works from the code alone.
   - Take an accessibility snapshot first. It proves structure, labels and states as text without spending an image, and its element ids drive hover, click, fill and keypress, so interaction states (hover, open menu, filled form, error) are reachable in the same session. Check the console for runtime errors.
   - Then one screenshot per size: `1920x1080` desktop, `1280x800` laptop, `390x844` mobile with touch. **Read all three.** Nothing clipped or overflowing on mobile, no awkward whitespace on desktop, nav behaving. Compare against the rules above: alignment, spacing, contrast, hierarchy, and whether the change reads as intended.
   - Size the viewport with device emulation, never by resizing the window. Window managers clamp window sizes (a 390px request can land at 848px), and the screenshot silently records the clamped size.
   - Pages that scroll inside an inner container defeat full-page screenshots, which capture only the visible box. Emulate a tall viewport instead (e.g. `1600x2600`). Clear the emulation when you finish.
   - If you cannot see the page (dev server down, browser tools missing), say so explicitly rather than claiming the UI works.
3. **Break it on purpose** (§18). Go offline, fail the payment, empty the lists, then look at what renders. A surface checked only on the happy path is not verified.

## 13. Anti-patterns (will be rejected)

- Inventing a class for a one-off layout instead of composing existing tokens and utilities.
- Hardcoded colors (`color: #333`, `background: rgb(20, 20, 20)`).
- Inline SVG icons outside the icon registry.
- Reimplementing a modal, card or spinner because the existing API "almost fits".
- A local state mirror with a hand-written rollback where the framework has an optimistic mechanism (§5).
- Reloading the whole page after a mutation when the touched queries can be refreshed.
- Spinner-then-success for a trivial mutation that should be optimistic.
- Optimistic updates on payment, auth or irreversible destructive actions that should be deliberate.
- A font, color, radius, or shadow that has a near-equivalent token already.
- **Overriding heading `font-size` in a component** instead of picking the right heading tag.
- Magic z-index numbers instead of the layer scale.
- Buttons missing one of: hover, active, disabled.
- Removing `:focus-visible` outlines for "cleanliness".
- A hand-rolled `position: absolute` plus window click listener for a floating panel instead of the shared mechanism (§11).
- `title=""` as a tooltip (§11).
- Re-declaring `text-wrap: balance`/`pretty` or fighting them with manual `<br>` (§3).
- A separate color variable for a border or icon that should track its text with `currentColor`.
- A new literal for a one-off lighter or darker shade of an existing token, instead of deriving it with `oklch(from var(--token) ...)`.
- A special-case override (border-all-then-reset-last) where `:not(:last-child)` is cleaner.
- A first-run tutorial modal or feature tour where a constrained first path would teach the same thing (§17).
- Sending a user who hit a locked feature off to the pricing page instead of rendering the gate in place (§16, §17).
- A mutation that refreshes only the acting user's view of a row several people edit (§17 Multiplayer).
- One-off purchases (credit packs, single unlocks) sitting beside the plans on the main subscription paywall (§16 Paywalls).
- Monthly and annual shown as equal side-by-side cards with nothing preselected (§16 Paywalls).
- Centered text in a dense row or card body where a left label and right value would scan (§4).
- A divider, border, or nested card papering over content that is simply misaligned (§4).
- Making the primary action louder instead of making its neighbors quieter (§4).
- A long list of identical text rows with no avatar, chip, icon, or grouping for the eye to land on (§14).
- A sentence or tooltip explaining something a small diagram, icon, or preview would show outright (§14).
- A sticky header subtracted in JS on an anchor jump instead of `scroll-margin-block-start` on the target (§11).
- A horizontally scrolling tab or chip strip with no snap points, or `mandatory` snapping on a strip of many small items (§11).
- Styling `:invalid`/`:valid`, which paints required fields red before the user has typed (§11).
- A bare `:focus` ring on a button, link or trigger, which flashes on every mouse click; use `:focus-visible` (§11).
- Line-count heights written in `em`/`rem` instead of `lh` (§11).
- A JS textarea resizer where `field-sizing: content` does the job (§11).
- A happy-path-only screen whose error, offline, empty and expired states fall through to framework defaults (§18).
- Clearing the user's input after a failed submit (§18).
- One concept or action named two ways on two screens ("workspace" here, "team" there; "Delete" here, "Remove" there) (§18).
- "Something went wrong" with no cause and no next step (§18).
- A flow that ends in a bare redirect with no word on what was saved or what comes next (§18).
- A double-click or long-press action that competes with the single action and fires without waiting, or a wait added where the second input only extends the first (§19).
- A submenu that closes when the pointer cuts diagonally toward it, or one held open by a plain close timeout instead of the aim triangle (§19).
- A confirm modal on a reversible action where acting at once plus an Undo toast would do (§19).
- A Save/Cancel footer on a settings page whose fields could each save on change (§19).
- An action button that fires on `pointerdown` or `mousedown` instead of `click` (§19).
- A fee, exchange rate or minimum that first appears at the last step of a payment flow (§20).
- A transaction state that says only "Pending" or "Processing", with no reason, no next step and no way to reach a person (§20).
- A risk of irreversible loss (wrong network, wrong account number) explained only in a tooltip, help page or the terms (§20).
- Freeze, spending limits or balance hiding buried in settings instead of one tap from the main view (§20).
- Reward promos scattered across screens instead of one rewards history (§20).

## 14. Dashboard design principles

Three principles for dashboards, tables, and dense data surfaces. They assume the scanning behavior in §4: the user is hunting for one value, and density is a problem only when everything looks the same. Violations read as amateur work.

### Data-driven design (let the data dictate the form)

- Match the UI pattern to the data type. Categorical values (status, department, employment type) become chips or badges, not plain text. Sequential events become a timeline, not a time-sorted table. Don't default everything to rows of text.
- **Numeric columns**: right-align by place value so digits line up (the receipt rule, §4), and format consistently (fixed decimals, thousands separators). Never left-align money or counts.
- **Long text**: truncate with an ellipsis and expose the full value on hover and focus through the tooltip mechanism (§11), not `title`. Don't let one long cell blow out row height or column width.
- **Semantic color, not decoration**: color encodes a data state (overdue = danger, healthy = success, pending = warning). Never color for visual flourish. Pull states from tokens (§2).
- **Differentiate, don't thin out.** Dense is fine; uniform is not. A wall of same-size, same-weight text has no landmarks, so every lookup restarts at the top. Give each row at least one non-text anchor the eye can lock onto: an avatar for a person (required anyway, §1, and recognized faster than a name), a color-coded status chip, a leading icon, or the one number that matters set in a heavier weight. Then **group rows under headers by whatever the user is hunting by** (due today / this week / later, by stage, by assignee, by location), so one long list becomes several short ones. Anchors and grouping buy scannability without removing information (§15).
- **Show, don't tell.** A stop sign is recognized before the word "stop" is read. Where a value has a shape, draw it: a layout option renders a miniature of that layout, a route shows a map thumbnail, a color setting shows the color, a status shows its chip, a file shows its thumbnail. Reserve prose for things with no visual form. Recognition beats reading, so a diagram or icon removes the tooltip or paragraph that would otherwise explain it. This never replaces the accessible name: icon-only controls still carry an `aria-label` and a visible tooltip (§11).

### Progressive disclosure (reveal by importance)

- **Hierarchy of actions**: keep the primary action visible and inline. Tuck secondary and infrequent actions (share, remove, duplicate, export) into a hover-revealed menu or an overflow (`⋯`) button (§11 Floating panels). Don't line up ten equal-weight buttons per row.
- **Spectrum of explicitness**: reveal functionality as the user explores or triggers it (hover, focus, expand) instead of showing everything at once.
- **Onboarding**: sequence complex functionality. Don't dump a fully loaded dashboard or a dense modal on a first-time user. Introduce key actions with progressive tooltips.
- **Bushnell's Law: easy to learn, difficult to master.** The first screen exposes one obvious path. Depth stays reachable but out of the way, so power users find keyboard shortcuts, bulk actions, saved filters and advanced settings by exploring rather than by being shown them on day one. Depth nobody discovers is wasted work; depth on the first screen is a wall. Ship both layers, ordered.

### Invisible UI (the hidden half is the craft)

- A finished dashboard needs a lot of hidden UI to feel complete: hover-state row actions, copy buttons that appear on hover, comment and attachment indicators, tooltips on ambiguous labels and icon-only buttons, and empty, loading and error states.
- Every icon-only control and every abbreviation gets an `aria-label` **and** a visible tooltip (§11 Tooltips). No unlabeled icon buttons, and no label that only screen readers can see.
- The value is in **orchestration**: states, drawers, popovers and hover affordances working together so the surface stays usable at scale. Assembling the visible pieces is the easy part; budget for the invisible ones.

## 15. Value over minimalism (don't strip for its own sake)

The test for every element is **"Does this add value, or is it a distraction?"**, not "how minimal can I make this?" Empty space is not automatically better, and removing a useful affordance to chase a clean look is a regression.

- **Hierarchy over minimalism.** Don't delete elements just to gain white space. Use typography, color and spacing to build a clear hierarchy so the eye knows where to land first. A crowded but ordered screen beats a sparse but flat one.
- **Context matters.** When a user searches or acts, give context (snippet previews, search suggestions, a helpful empty state with next steps) instead of a bare list or a naked "No results found".
- **Design for utility.** Sometimes more is better. Tooltips on charts, progress indicators during loads, inline hints: if an element carries information the user needs, it improves usability regardless of element count.
- **Structure complex information.** For data-heavy surfaces or walls of text, group related items rather than deleting them; §4 (edges, grouping, dissolved containers) and §14 (row anchors, grouping headers) have the mechanics. Drop redundant labels when the value is self-evident, and keep critical actions consistently styled so they stay findable.
- **Add depth and delight.** Use depth (shadow tokens, highlights) and subtle gradients so surfaces don't look soulless. Logical grouping plus subtle visual cues turn a basic UI into a finished one, always within the token system (§2).

## 16. Behavioral design (design for how people decide)

Good UX also means making the next action feel obvious, valuable, and worth completing, by working with how people actually decide. Apply these to forms, onboarding flows, upgrade prompts, and pricing surfaces.

- **Smart defaults.** Pre-fill forms with the most common choice. Users read a default as an expert recommendation, so the task feels like an adjustment rather than a chore. Select the likely option (plan, quantity, notification setting) over an empty field, keep it easy to change, and never default destructive or billing-increasing choices. The one exception is a paywall the user opened to buy, where the annual plan is the default (Paywalls, below).
- **Goal-gradient effect.** Never start a user at 0%. Count steps already taken (account created, first contact added) as progress, so a multi-step flow opens at around 20%. Visible momentum motivates completion. Use progress bars or step indicators on onboarding, setup checklists, and multi-step forms.
- **Reciprocity.** Give value before asking for a signup or upgrade. Something useful first (a real quote, a usable report, a working preview) creates a pull to return the favor. Let the user reach a genuine result before hitting a wall.
- **IKEA effect.** Let users invest effort or personalize before a signup or paywall. People value what they helped build and abandon it less. Preserve their work across the wall: carry a drafted document or configured widget through signup instead of discarding it.
- **Loss aversion.** Losing hurts about twice as much as gaining pleases (Kahneman). Frame upgrade and retention prompts around what the user stands to lose ("you'll lose access to your saved routes"), not only what they'd gain. Use it for trial expiry, downgrade and cancellation flows, honestly, never with fake scarcity.
- **Contrast effect.** People judge prices relative to each other. Show a high-value, high-price item first so secondary costs read as small ("+$19/mo" next to the annual plan feels negligible). Order tiers and add-ons so the anchor comes first.
- **Icebreaker (small first commitment).** The hard conversion is the first payment, not the largest one. A cheap, obviously worthwhile first purchase (one add-on, a metered top-up, a low-tier month) turns a non-payer into a payer, and every purchase after that is easier. When a gate blocks one specific paid capability, offer the smallest real unit for it alongside the plan jump, and deep-link the call to action straight to it. This applies to that gate only. The main subscription paywall carries no one-off units (Paywalls, below).
- **Monetize at the moment of need.** A prompt converts when the user has just felt the need, not on a static pricing page they have to go find. Render the gate where the action was attempted, in place of the locked surface. A quota wall belongs on the blocked action, not in settings. Never redirect a blocked action to a billing page, and never let a page load die on a bare 402 when the client could explain it: loads render, mutations enforce.

**Core takeaway:** apply these honestly. They should surface real value and reduce friction, not manipulate. No dark patterns, no fake scarcity, no defaults that cost the user money without clear consent.

### Paywalls: structure before price

When a paywall underconverts, change its structure before you cut the price. Which options appear, which one is preselected, and whether the offer is a discount or a trial often move revenue more than a price change does.

- **One offer per paywall.** The subscription paywall sells the subscription and nothing else. A credit pack or one-off unlock next to the plans gives the user one more choice to weigh and an escape hatch toward the smaller purchase. Mojo pulled AI credit packs off its main paywall and subscription revenue rose 14%. Small one-off units still have a place at the gate for that one capability (icebreaker, above), never next to the plan picker.
- **Lead with annual, keep monthly one tap away.** Show and preselect the annual plan. Put monthly behind a "See all plans" link instead of beside annual as an equal card. People stick with whatever is preselected. Built with Science made this change and annual share went from 60% to 75-80%. Print the billed total next to the per-month figure ("$59.99 billed yearly") so the default never hides what gets charged.
- **Trial over discount.** A full-access free trial lets the user own the product before paying for it, and people value what they already have. That is the endowment effect. Pregnancy Plus tested a discounted intro price against a free trial, and the trial earned 140% more revenue, with trial users also staying longer. State the trial end date and the charge on the paywall, remind the user before the first charge, and frame the end of the trial around what they lose (loss aversion, above).
- **Test structure before price.** Remove or reorder plans, change the default, swap a discount for a trial. Change one thing per test. Judge the result by revenue and retention, not conversion rate, because a cheaper default can raise conversion and lower revenue.

## 17. Product as a game loop

Games get one shot at teaching a stranger a system with no manual, so their tools for onboarding, feedback and difficulty transfer directly. Four lenses, in the order they matter when designing a module.

### Name the loop before you design the screen

Every module is a loop. Write it in one line before touching markup:

1. **Input** the user gives: a prompt, a form, a drag on a calendar, a shape traced on a map.
2. **Response** the system returns. Immediate, and legible as a change the user caused (§5, §7).
3. **Rules** that constrain the input: permissions, plan features, feature flags, quotas, required fields. Rules are part of the design, not an error path. A blocked input reads as a rule with a way forward (§16 moment of need), never a dead end.
4. **Context metaphor**, the mental model the user borrows: a document editor as a sheet of paper, files as a folder tree, a pipeline as stages on a board, availability as a calendar. Pick the metaphor first, then make every affordance obey it. A mixed metaphor costs more than a missing feature.
5. **Polish** that makes the loop pleasant to repeat (§10, plus Juice below).

If you cannot state the loop, the surface is a form, not a feature. A missing step 4 is the usual reason a screen technically works and still confuses people.

### Implicit onboarding: teach with constraints, not text

Teach through what the interface allows, not through instructions. Narrow early choice until the core mechanic is unmissable, then widen.

- **Restrict the first path.** An account with no data shows one primary action, not the full toolbar (an empty state with a single call to action, §7). Reveal filters, bulk actions and secondary tabs as real rows appear.
- **Make the valuable action the cheapest one.** Order, size and default the option you want learned so the user stumbles into it (§16 smart defaults). Charging friction for the correct path teaches the wrong lesson.
- **Copy is the fallback, not the mechanism.** A tour modal or a wall of onboarding text is what you write when the interface failed to teach. Prefer the constrained first path, then progressive tooltips on the few controls that are genuinely non-obvious (§14).

### Juice: feedback that makes the loop feel alive

Juice is disproportionate feedback for a small action. It separates a surface that works from one that feels crafted, and it is cheap: the same mutation, plus motion that confirms it.

- Attach the effect to the exact thing the user changed: the row being deleted fades and collapses, a saved field flashes the light accent color, a menu springs open, a counter ticks instead of jumping.
- Keep it short and interruptible: the default transition for state changes, 150 to 300ms for entrance and exit (§10). Juice that outlasts the user's next click is lag.
- Compounding beats spectacle. Several small confirmations on a loop someone runs fifty times a day are worth more than one elaborate animation on a page they see once.
- Respect `prefers-reduced-motion` (§10).
- No UI sound unless the project skill says the product has any.

### Multiplayer: shared state is the default

Workspace data is multiplayer. Every row one member edits is visible to other members, and often to a customer on a public page, so design for concurrent actors rather than one user at a time.

- **Refresh what the other person is looking at.** After a mutation, refresh every query that reads the changed row, or some view keeps serving stale data (§5). An optimistic placeholder only repairs the acting client.
- **Expect boundary pushers.** Double submits, two open tabs, a form posted an hour late, an id belonging to another account. Disable in-flight submits and validate on the server; a client-only guard is not a rule.
- **Build the safety net.** Destructive actions go through soft delete so a mistake is recoverable. With that in place the delete runs at once and offers Undo, which beats a second confirm dialog (§19). Only a hard delete with no way back stays deliberate (§5).
- **Show who.** When state is shared, attribution is part of the UI: who changed it and when, with an avatar (§1). An "Assigned to" field with no face is a multiplayer surface pretending to be single player.

## 18. Premium feel lives in the unglamorous states

AI-generated screens look finished on the happy path and come apart everywhere else. The gap between a fast product and a premium one is the work nobody screenshots: feedback, undo, recovery, consistency between screens, and the moment something breaks. Give those states the same design care as the primary success screen. They cut the user's mental effort, and they are where trust gets built or lost.

### The unglamorous parts first

- **Every action answers.** A click with no visible result makes the user wonder whether it worked, and that doubt is mental load (§7).
- **Undo beats confirm.** A reversible action with an undo toast costs one click. A confirm dialog costs a decision every single time, and people learn to click through it (§17 safety net).
- **Recovery keeps the user's work.** A failed submit leaves the form filled, names the field or the cause, and offers the next step (retry, edit, contact). Never clear input on failure.
- **Endings are screens too.** Session end, logout, timeout, task complete, cancel: say what was saved, what happens next, and how to pick up again. A bare redirect at the end of a flow throws away the trust the flow earned. The app Undertone raised retention by fixing nothing more than an unhelpful session-end flow.

### Connective tissue between screens

Users experience the app as one product, not a stack of screens. Screens generated one at a time drift apart in wording, layout and behavior, and the drift reads as carelessness even when each screen is fine alone.

- **One name per concept.** Nav, headings, buttons, toasts and emails use the same term for the same thing, and the same verb for the same action. "Workspace" never turns into "team" two screens later.
- **One structure per job.** List pages share a layout, detail pages share a layout, settings pages share a layout: header, primary action placement, filter bar, empty state. Copy the canonical reference (§0 step 3) instead of generating a fresh arrangement.
- **One pattern per interaction.** Deleting a row, editing inline and opening a detail drawer behave the same on every screen that offers them.
- **Hand-offs carry context.** Breadcrumbs show where the user is (§1). The item they came from stays highlighted. Back restores scroll position. A success toast names what was created and links to it.
- Before shipping a new screen, open it beside its two closest siblings and compare copy, structure and action placement.

### Worst-case moments

The service recovery paradox: a user whose problem gets resolved well often ends up happier than one who never hit a problem. That makes failure states some of the highest-leverage screens in the product, and the ones most often left to defaults.

- **Payment failure.** Say what failed in plain words (declined, expired, insufficient funds, as the processor reports it). Keep the plan choice and form intact, offer another method, and state what the user keeps in the meantime ("Your access continues until March 3").
- **Connection loss.** Show the offline state persistently but quietly, keep or queue unsent input, retry on reconnect, and confirm when back online. A typed message must never vanish.
- **Empty data.** Distinguish the cause (nothing yet, filters excluded everything, no permission) and offer the action that fixes that cause (§7, §15).
- **Server errors and missing pages.** Plain-language cause, what the user can do, and a way back. No stack traces, and no "Something went wrong" standing alone.
- **Error copy owns the problem and names the next step.** "We couldn't save your changes. Your edits are still here. Retry" beats "Error 500".

### Break it on purpose

Open the product and break it before calling a surface done. Each break below produces a state; design that state with intent instead of accepting whatever renders.

- Go offline (devtools network throttling set to offline) mid-load and mid-submit.
- Fail a payment with the processor's decline test card.
- Empty every list: a fresh account, a filter that matches nothing, a user without permission.
- Submit invalid data, double-click submit, and let the session expire with unsaved work open.

## 19. Intent: wait, infer, or act first

Every input is ambiguous until the software decides two things: what the user meant, and how sure they were. There are three ways to settle it, and each has a price. Waiting costs time. Inferring costs certainty, because the guess can be wrong. Acting first costs trust, because the user has to believe there is a way back. Pick the cheapest one the interaction allows, and pick it on purpose.

### Wait only when actions compete

One input that can start two different actions has to wait to find out which. A press on an AirPod stem takes about 700ms to pause the music, because a second or third press means skip. The phone pauses in under 300ms, since play, next and previous are separate buttons and nothing is ambiguous.

- **Compete or extend.** Delay only when the first action would be wrong if a second input follows. A task row where one click opens the detail page and a double-click renames inline competes. Navigating on the first click makes the rename impossible. A table cell that selects on the first click and edits on the second extends. The selection is right whether or not a second click comes, so it fires instantly. Design double-click and long-press as extensions of the single action wherever you can, and no delay is needed.
- **How to wait.** Schedule the single-click action and cancel it when a second click arrives (`event.detail === 2` on the next `click`, or `dblclick`). Raymond Chen documented this for Windows in 2009. No web API exposes the OS double-click time. Windows defaults to 500ms, so a window much shorter than that turns a slow double-click into a navigation.
- **Is the shortcut worth the delay?** Every single click now pays the wait. The alternative is to remove the competition: rename only on the detail page, and the row opens instantly. Keep the delay when the shortcut earns it, as skipping without reaching for the phone or renaming in place in a list does.

### Infer from movement

Ohio State paved its quad in 1914 along the paths students had already worn into the grass. Pointer movement is the UI's worn path. Read where the cursor is heading and how fast, then act on the likely target without asking the user to wait.

- **Submenu aim triangle.** When the pointer leaves an item whose submenu is open, draw a triangle from the pointer to the submenu's near top and bottom corners. Keep the submenu open while the pointer stays inside that triangle and keeps moving. If it slows down or stops, the user is aiming at the item under the pointer, so switch to that item's submenu. Linear, Notion and Attio all do this, and Ben Kamens documented it in 2013. Use the floating-panel mechanism's version (Floating UI `safePolygon()`, Radix submenus) instead of a close timeout. A timeout makes moving down the list sluggish and still closes on a slow diagonal.
- **Tooltip warm-up.** The first tooltip waits (around 500 to 700ms) so a cursor passing over the toolbar doesn't trigger it. Once one has shown, neighboring triggers show theirs instantly as long as the pointer moves between them within a short skip window (around 300ms). The user has shown they want labels, so stop making them wait for each one (§11 Tooltips).
- **Dwell before an edge reveal.** A collapsed sidebar that peeks out on hover opens only after the pointer rests at the edge for a moment, as Notion's does. A pointer sweeping past on its way to the browser tabs or a scrollbar should not open it.
- **Show the guess when it can be wrong.** A row dragged near the bottom of a list might be meant to drop there, or the user might want the list to scroll so they can drop it further down. Don't make that a binary switch. Draw the drop indicator where the row will land, and make the edge zone a gradient where scroll speed grows the closer the pointer gets to the edge. A visible guess is corrected by moving a few pixels; a hidden one is discovered after the drop.

### Act first, then offer the way back

Most of the time the user meant it. A confirm modal makes the 99% confirm what they already intended to protect the 1% who slipped, and the 99% learn to click through it without reading (§18).

- **Delete, then undo.** Remove the item at once and show a toast with Undo (§7). Back it with a soft delete: the item moves to a "Recently deleted" list and a job purges it after 30 days, so recovery outlives the toast. The user only touches the toast when they made a mistake.
- **Delay the side effect, not the feedback.** Gmail says the message is sent right away and holds the actual send for 5 seconds (configurable up to 30) with Undo in the toast. That is seven times the AirPod delay and nobody notices it, because the UI already reported success. Use this for anything that leaves the system and can't be recalled once it has (an email, a notification to other people, an outgoing webhook).
- **Autosave instead of Save.** Settings save each field on change and confirm inline with "Saved" (§7). Editors save on their own, periodically or on change. Autosave needs a way back to replace Cancel: undo within the session, and version history for documents. A user might save a file a hundred times for every once they need an old version, so the history can live behind a menu.
- **Keep the confirm for the irreversible and the unusual.** Moving money, a bulk send (an email to 10,000 recipients), a hard delete with no soft delete behind it, an action the user rarely performs. These keep a confirm step and stay deliberate (§5, §6 reassurance delay). Undo works only when there is something to undo.

### Commit on release, so every press can be cancelled

Waiting, inferring and acting first all guess how sure the user is. Committing on release lets the user say so.

- **Buttons fire on release.** Bind actions to `click`, which fires only when press and release land on the same element. Pressing, sliding off and releasing cancels. That is a built-in cancel on every button, and an action bound to `pointerdown` or `mousedown` throws it away. A camera shutter works the same way: half press focuses and shows the shot, full press takes it.
- **Menu triggers open on press.** A button that opens a menu, select or popover opens on `pointerdown`, so the user can press, drag to an item and release on it in one motion. Releasing over the trigger leaves the menu open. These look like buttons but behave as toggles, which is why the two follow opposite rules. Check that the open menu commits the item under the pointer on release.
- **Gestures show how close they are to committing.** Pull to refresh and swipe to delete track the finger and show progress toward the threshold (the spinner fills, the row reveals its red action). Released short of the threshold, they spring back and nothing happens. Cmd-Tab on macOS shows the switcher while held, commits on key release, and Escape cancels before that. Any press-and-hold interaction follows the same rule: show the pending outcome, commit on release, and let Escape or moving back cancel.

## 20. Trust with money: real, safe, in control

Someone deciding whether to hand an app their paycheck asks three questions, in this order. Is this company real? What happens if something goes wrong? Once my money is in, am I still in control? Every screen of a money product (signup, deposit, checkout, wallet, payout, billing) answers one of them. Zipzap redesigned the crypto neobank Soulcard around these questions. Afterwards users loaded 79% more money onto their cards and successful card deposits rose 71%. None of this is specific to crypto. A payroll tool, a marketplace payout screen and a SaaS billing page face the same three questions at lower stakes.

### Is it real? The surface is the evidence

A first-time visitor can't check your licenses from a landing page, so they judge by how it looks. The question they're asking is whether the company will still exist in a year, not whether the design is fun.

- **Finished beats playful.** A rushed or dated surface reads as a company that might fold. One brand, one type system and one set of components across site, onboarding and app (§18 connective tissue) are the cheapest proof of permanence.
- **Answer objections before they're asked.** The first screen ends on plain, checkable promises: "Card issued in seconds. No annual fees. Refund anytime." Stating terms unprompted reads as having nothing to hide. Write only promises the product keeps, because one broken promise discredits the rest.
- **Show ordinary life.** Picture the product where money actually moves: groceries, rent, a taxi, a restaurant bill. A product shown only inside its niche reads as a side account, not a place for a salary.
- **Give ownership before asking for money.** Pick the one object the user will own (the card, the account, the workspace) and make it the thread. It appears on the landing page, choosing it is the first onboarding step, and the app puts it front and center. By the time the deposit form appears, it already feels like theirs. In the mug study (Kahneman, Knetsch and Thaler, 1990), people handed a mug asked more than twice what others would pay for it. That is the same endowment effect a free trial uses (§16 Paywalls).

### What if it goes wrong? Design out the surprises

The first deposit is the first time the user hands over real money, and their worry is simple: what if I send it, something breaks, and I can't get it back? Each surprise turns a natural next step into a gamble. A bare form and a spinner do nothing for that worry.

- **Fee and received amount before the pay button.** Show what leaves, the fee, and what arrives ("You send $100.00, fee $1.50, card receives $98.50"), right-aligned (§4) and updated as the amount changes. Never reveal a fee, rate or minimum at the last step. Hiding fees until checkout made StubHub buyers 14% more likely to purchase, because walking away after the effort feels like a loss. That wins one purchase. A fee found at the end reads as a trick, and nobody makes a second deposit with an app that tricked them.
- **Put the irreversible risk beside the field that causes it.** When one wrong input can lose money for good (wrong network, wrong account number, wrong IBAN), state the consequence in plain words next to that input: "Send on the wrong network and your money may be lost or take weeks to recover." Never only in a tooltip, a help page or the terms. People stress more over an uncertain outcome than over a certain bad one (de Berker et al., UCL, 2016), so a definite warning calms more than a vague maybe. Where code can prevent the mistake, prevent it too: validate the address format for the selected network, and preselect the network when only one works.
- **Status screens are the product.** Many users pay through Apple Pay or Google Pay and open the app only to check on their money. Did my deposit land? Where did that payment go? Give every transaction state its own designed screen. Soulcard has 15, among them processing, on hold and declined. Each one says what happened, why, what comes next and roughly when, and links to a person (below). "Pending" alone is not a status. "Your transfer is temporarily on hold while we complete routine checks", with a Contact support button, is one. Count the progress where it's countable (§8). Get these screens right and people wait instead of flooding the support inbox.
- **Break the money path on purpose** (§18). Decline the card, put a transfer on hold, send on the wrong network in a test environment, and look at every screen that renders.

### Am I still in control? Off switches within reach

Once the money is in, the worry changes. In Glass and Singer's 1972 noise study, people given a button that stopped the noise mostly never pressed it, yet knowing it was there made the noise hurt their work less. Most users never freeze their card either. The switch still has to be one tap away.

- **Controls on the main view, not in settings.** Freeze card, lock online payments, set spending limits, reveal PIN: each is one tap from the home screen, and on web freezing sits on the dashboard. Freezing is reversible, so it takes no confirm dialog (§19). It is also not optimistic (§5). Show "Frozen" only after the server confirms, since a card that displays frozen while it still works is worse than a half-second spinner.
- **Let the user hide the balance.** One toggle masks every balance and amount, and the choice persists across sessions. Render a mask ("••••") rather than a CSS blur over the real figure, so the number stays out of the DOM, the clipboard and screen reader output. On mobile, hiding when the phone is laid face down is a cheap extra. A large balance on screen in a café is a real risk: 2025 set a record for wrench attacks, where criminals physically coerce crypto holders into handing over their coins.
- **Rewards get one home.** When payment runs through a phone wallet, the app and its reward are invisible at the moment of purchase. Plastering rewards over every screen to compensate reads as a scam. Give them one history that lists what each purchase earned ("$0.85 back on Uber"), so every visit shows a quiet reason to keep using the card.
- **A person one message away.** Support is reachable from every status screen and from the account menu, in channels users already use (email plus a chat app such as WhatsApp or Telegram), and answered by people. Like the noise button, most users never press it. Knowing it's there is what lets them leave the money in.
