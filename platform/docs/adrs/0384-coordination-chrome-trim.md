# ADR-0384: Strip the non-reload.chat chrome — header + feed + composer + members only

- **Status:** Accepted (web surface only; gated default-OFF + owner-workspace-first; no prod flag flipped here)
- **Date:** 2026-06-19
- **Context issue:** [#384](https://github.com/gagan114662/agent-skills/issues/384) — owner feedback, with
  [reload.team](https://reload.team) as the bar: the coordination view now renders dark + scrollable + with a
  working composer (#381), and agents run when briefed — but it still shows **ipop-specific chrome above the
  chat that reload.chat does not have**, which pushes the feed down and breaks the clean look.
- **Epic:** [#359](https://github.com/gagan114662/agent-skills/issues/359) — make the reload.chat vision real.
- **Builds on:** [ADR-0381](0381-coordination-viewport-layout.md) (the single-scroll-region layout this
  preserves), [ADR-0378](0378-reload-chat-whole-app.md) (reload.chat as the whole app),
  [ADR-0362](0362-live-coordination-feed.md) (the live feed),
  [ADR-0370](0370-agent-channel-bridge.md) (running status arrives as in-channel agent messages),
  [ADR-0352](0352-agent-coordination-surface.md) (the default-OFF, owner-first `coordination-flag`),
  [ADR-0013](0013-approval-gates.md)/[ADR-0243](0243-money-only-approval.md) (the #13 gate),
  [ADR-0200](0200-premortem-panel.md) (the premortem rails).

## Context

reload.chat's main pane is ONLY: a slim channel header (`# name`) → the message feed (full height) → the
composer, with a members rail on the right. The coordination surface added ipop-only chrome on top of that:

1. A large **"Team coordination"** preamble (title + one-line sub) and a **"Mission control"** running-sessions
   **table** (`.coord__live` → `MissionControlPanel`) sitting above the message feed — pushing the feed down.
2. A busy app header: `#seo · $0.00/$5.00 on track · Upgrade · needs a human — N pending · N waiting on you ·
   Settings · Sign out · running` — a budget gauge, an Upgrade button, and a fleet-health banner over the chat.

Running-session status is **already** delivered as in-channel agent messages by the #370 bridge
("✅ session completed (exit 0)"), so the table duplicated information the feed already shows — at the cost of
the clean look.

## Decision

Three web-only changes, all under the existing `coordination-flag` (#352) — production (no env) is unchanged.

1. **`CoordinationView` is header + feed + composer + members only.** Removed the `.coord__head` preamble
   (the "Team coordination" title + sub) and the `.coord__live` section (`MissionControlPanel`). The view is
   now a single full-height `.coord__body` (channel sidebar · message pane · thread · members). The
   "Team coordination" string survives as the region's `aria-label` so the surface stays nameable to assistive
   tech and tests, with no visible chrome.

2. **Slim app header (`ConsoleView`), gated on the coordination surface.** When the reload.chat surface is the
   whole app: the budget **gauge**, the **Upgrade** button, and the **fleet-health** banner are no longer
   rendered in the header — they remain reachable, unobtrusively, in **Settings → Billing**
   (`BillingSettingsPanel` already embeds the spend summary **and** the upgrade path). Approvals stay a small
   **"N waiting on you"** chip; account utilities stay a gear (**Settings**) + **Sign out**. The live indicator
   reduces to a small calm **"N running"** pill (`.runpill`), shown only when something is actually running —
   never a table. The pill reads the mission-control snapshot `ConsoleView` already polls (#147), so no new
   fetch and no new seam. When the gate is **off** (production), `showCoordinationSurface` is always false, so
   the board keeps its gauge / Upgrade / fleet-health exactly as today.

3. **The #381 layout is preserved.** The feed still fills the vertical space from header to composer inside the
   single `.messagelist` scroll region, the composer stays a pinned `flex: none` sibling after it, and the
   members rail is unchanged.

`MissionControlPanel` (and its #362 `useLiveMissionControl` hook) is **retained, not deleted** — it is simply
no longer mounted on the trimmed surface. Keeping it makes the change fully reversible (the table can be
re-mounted if ever wanted) and leaves the #362 pure logic (`mission-live.ts`) and its tests intact.

## Tradeoff: live-ness of the running indicator

The #362 deliverable made the mission-control strip update sub-second from websocket events. With the table
gone, the running **count** now reflects `ConsoleView`'s existing 4s mission-control poll (≤4s to update)
rather than a per-event refetch. This is an intentional, issue-mandated downgrade ("reduce it to a small
'N running' pill … not a table"). The **message feed itself stays fully live** — agent messages still arrive
over the socket within the sub-second window (the heart of #362), which `CoordinationView.live.test.tsx`
continues to pin.

## Why render + CSS-source tests

jsdom does not compute CSS layout, so visual trim is asserted structurally. `CoordinationView.test.tsx` gains a
case proving the preamble heading and the mission-control table are **absent** from the DOM while the feed +
composer + members remain. `ConsoleView.coordination.test.tsx` gains a "slim header" group: the gauge / Upgrade
/ fleet-health are not in the header on the coordination surface (and the board keeps them when the gate is
off), and a small "N running" pill — not a `.mission__table` — appears when sessions are live.

## #200 rails

- **Web-only, no new backend, no new action path.** Pure removal + a header pill that reads an existing poll.
  Every irreversible/money action still stops at the **#13** gate, reachable from the header's "waiting on you"
  chip. Budget/Upgrade moved *into Settings*, not removed — the conversion path is preserved, just not a banner
  over the chat. Nothing here touches the approval queue.
- **DATA, not instructions:** message/channel/member strings remain React text only (no
  `dangerouslySetInnerHTML`); the existing injection test (`<img onerror>` rendered verbatim) still holds.
- **Gated, owner-first, default-OFF, reversible:** the trim only applies for the named owner workspace when
  `VITE_RELOAD_COORDINATION_UI` is set; production sets no env, so the board is byte-for-byte today's app.
  Reverting the diff fully restores the preamble, the table, and the full header.

## Alternatives considered

- **Delete `MissionControlPanel` outright.** Rejected — retaining it (unmounted) keeps the change reversible
  and preserves the #362 hook/logic and tests; deletion buys nothing the gate doesn't already give us.
- **Drive the "N running" pill from `useLiveMissionControl` for sub-second updates.** Rejected for this slice —
  `ConsoleView` already polls mission control on a 4s beat for the board, so reusing that snapshot is zero new
  wiring; a ≤4s pill is well within the issue's "small pill" mandate and the message feed stays live regardless.
- **Move search / Members / gear into the channel header as new icons.** Rejected — search already lives in the
  channel sidebar (⌘K), the members rail is always present, and the gear is the existing Settings button;
  adding redundant header icons would re-clutter the very bar this issue asks to calm.

## Consequences

- For the flagged owner workspace the coordination surface is header + feed + composer + members — calm and
  uncluttered, matching reload.team. For everyone else (all of prod) the app is byte-for-byte today's board.
- Tests: a new "no preamble / no mission-control table" case in `CoordinationView.test.tsx`; a retrimmed
  `CoordinationView.live.test.tsx` (live message feed, the surviving #362 behaviour); a new "slim header" group
  in `ConsoleView.coordination.test.tsx`; the #362 strip-refetch assertions (which lived on the removed table)
  were dropped. Full web suite green (596).
- Follow-ups (epic #359): further reload.team parity polish as the channels populate in real time.
