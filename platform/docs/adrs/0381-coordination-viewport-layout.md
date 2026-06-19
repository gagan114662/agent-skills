# ADR-0381: Make the coordination surface usable — viewport layout, single scroll region, no stray overlay

- **Status:** Accepted (web surface only; gated default-OFF + owner-workspace-first; no prod flag flipped here)
- **Date:** 2026-06-19
- **Context issue:** [#381](https://github.com/gagan114662/agent-skills/issues/381) — owner feedback, with
  [reload.team](https://reload.team) as the bar: the coordination view ships the dark theme, the channel/DM
  sidebar, and a composer, but it is **unusable** — the message feed will not scroll and the composer is
  pushed off-screen, so you cannot send a message, let alone brief a lead.
- **Epic:** [#359](https://github.com/gagan114662/agent-skills/issues/359) — make the reload.chat vision real.
- **Builds on:** [ADR-0378](0378-reload-chat-whole-app.md) (reload.chat as the whole app),
  [ADR-0352](0352-agent-coordination-surface.md) (the default-OFF, owner-first `coordination-flag`),
  [ADR-0035](0035-config-layering.md) (layered owner-first flags),
  [ADR-0013](0013-approval-gates.md)/[ADR-0243](0243-money-only-approval.md) (the #13 gate),
  [ADR-0200](0200-premortem-panel.md) (the premortem rails).

## Context

Live diagnosis on the owner's dark preview (`data-theme=reload-dark`, current bundle):

- The centre pane collapsed to **~222px** instead of filling the viewport.
- `.messagelist` had `overflow-y: auto` but its parent height was **unconstrained**, so it expanded to the
  full height of all ~93 messages (`scrollHeight === clientHeight`, ~10000px) and **overflowed the page**,
  carrying the bottom-pinned `Composer` below the fold. `overflow-y: auto` never triggered because nothing
  ever constrained the height it would scroll within.
- A settings/project overlay was reported auto-open over the surface on landing.

Net: no in-feed scroll, composer unreachable → the owner could not message a teammate or brief a lead.

### Root cause

The height chain (`html/body/#root → .workspace → .console → .console__main → .coord → .coord__body → .pane →
.messagelist`) is definite down to `.coord__body`, which is `display: grid` with **no row track**. Its single
implicit row therefore defaulted to `auto` and **sized to content** — the tallest column being `.pane`, which
stacks the header + all ~93 messages + the composer (~10000px). Because `.pane` is a grid item with the
default `min-height: auto` (it refuses to shrink below its content), the row grew to fit every message, the
grid overflowed, and `.messagelist`'s `flex: 1` measured against a 10000px-tall parent — so it never needed to
scroll. The composer, a correct sibling pinned beneath the feed, was simply carried off-screen by the
overgrown pane.

The overlay was the board's per-project `ProjectSettingsSheet` (and the `PeekDrawer`) — both fixed,
full-screen elements that `ConsoleView` mounted unconditionally. On the chat-first landing there is no
affordance to open either (the board/standup triggers aren't rendered), so they only contributed a stray
fixed layer over the chat.

## Decision

Four web-only changes, all under the existing `coordination-flag` (#352) — production (no env) is unchanged.

1. **Constrain the grid so the surface fills the viewport instead of its content.**
   - `.coord__body { grid-template-rows: minmax(0, 1fr); }` — the crux. A `minmax(0, 1fr)` row caps the row at
     the available height (min 0) so the grid fills the pane rather than growing to message content.
   - `.pane { min-height: 0; }` — lets the pane shrink below its content (overriding a grid item's
     `min-height: auto`), handing the overflow to `.messagelist`.
   - `.messagelist` stays the single `flex: 1; overflow-y: auto` scroll region; the `Composer` stays a
     `flex: none` sibling **after** it, pinned to the bottom of the pane and always visible.
   - `.coord` fills its slot under the header via `flex: 1 1 0; min-height: 0` (with `height: 100%` kept as a
     fallback). `.sidebar` gets `min-height: 0` so its own `overflow-y` scrolls in the constrained row. The
     live mission-control strip (`.coord__live`) is capped and scrolls within itself so it can never push the
     conversation off-frame.

2. **No stray overlay on the coordination landing.** `ConsoleView` renders `ProjectSettingsSheet` and
   `PeekDrawer` only when `!showCoordinationSurface`. Both are board-only surfaces with no trigger on the
   chat-first landing; not mounting them keeps the landing clean and closed-by-default. When the gate is
   **off** (production), `showCoordinationSurface` is always false, so the board mounts them exactly as today.

3. **Polish to the calm, generously-spaced reload.team dark look** — roomier message rows (`9px 11px`,
   `gap: 12px`, `line-height: 1.5`), a more generous feed gutter (`18px 22px`, `gap: 6px`), aligned pane
   header / composer gutters (`22px`), and calmer channel/member rows. Spacing only — no token or structural
   changes.

4. **Sending already works once the layout is fixed.** Typing + **Enter** posts to the active channel through
   the existing `Composer → store.sendMessage` path (`postMessage`); **@** opens the mention menu
   (`store.searchMembers`) so the owner can address a teammate or a lead (e.g. `@hermes`). No composer logic
   changed — the bug was purely that the composer was off-screen.

## Why CSS-source layout tests

jsdom does not compute CSS layout, so a render-based test cannot observe a scroll region or an off-screen
composer. Following the repo precedent (`PricingTable.visibility.test.ts`, `brand.test.ts`, the #378
dark-token invariant), `CoordinationView.layout.test.tsx` asserts the layout **invariants against the
stylesheet source** — `.coord__body` declares `grid-template-rows: minmax(0, 1fr)`, `.pane` sets
`min-height: 0`, `.messagelist` is `flex: 1; overflow-y: auto` — plus a structural DOM guard that, with 93
messages rendered, the composer stays a reachable sibling that follows the single scroll region inside
`.pane` (pinned to the bottom, never inside the scroll area). These fail on the pre-fix CSS and pass after.

## #200 rails

- **Web-only, no new backend, no new action path.** Pure layout/CSS + a render guard. Sending posts through
  the existing chat seam; every irreversible/money action still stops at the **#13** gate, reachable from the
  header's "waiting on you" control. Nothing here touches the approval queue.
- **DATA, not instructions:** message/channel/member strings remain React text only (no
  `dangerouslySetInnerHTML`); the existing injection test (`<img onerror>` rendered verbatim) still holds.
- **Gated, owner-first, default-OFF, reversible:** the surface still only renders for the named owner
  workspace when `VITE_RELOAD_COORDINATION_UI` is set; production sets no env, so the board (which keeps its
  overlays) is byte-for-byte today's app. Reverting the diff fully restores prior behaviour.

## Alternatives considered

- **`justify-content: flex-end` on `.messagelist` to anchor the newest message.** Rejected — on an overflowing
  flex scroller this clips the top rows in several engines, which would re-break the very scroll this fix
  restores. The feed stays top-aligned.
- **A fixed pixel height on `.pane`/`.coord__body`.** Rejected — brittle across header/strip height changes;
  `minmax(0, 1fr)` + `min-height: 0` is the idiomatic "fill, don't grow" fix.
- **Leave the overlays mounted but force-closed.** Rejected — they are board-only with no trigger here, and a
  fixed full-screen element over the chat is exactly what the diagnosis flagged. Not mounting them is cleaner.

## Consequences

- For the flagged owner workspace the coordination feed scrolls within a single region and the composer is
  always visible and usable; for everyone else (all of prod) the app is byte-for-byte today's board.
- Tests: `CoordinationView.layout.test.tsx` (new — CSS-source invariants + the 93-message DOM guard) and two
  added cases in `ConsoleView.coordination.test.tsx` (no stray overlay on the coordination landing; the board
  keeps its closed sheet). Full web suite green.
- Follow-ups (epic #359): the live coordination feed (#362) and backend coordination enablement (#361)
  populate the channels in real time — this PR makes the surface they light up actually usable.
