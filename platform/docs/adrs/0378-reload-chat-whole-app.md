# ADR-0378: Make ipop BE reload.chat — chat-first whole-app surface, channels+DMs left panel, app-wide dark theme

- **Status:** Accepted (web surface only; gated default-OFF + owner-workspace-first; no prod flag flipped here)
- **Date:** 2026-06-19
- **Context issue:** [#378](https://github.com/gagan114662/agent-skills/issues/378) — owner directive: ipop
  must look and navigate **exactly like reload.chat** ([reload.team](https://reload.team)), not a kanban
  board with a Conductor-style projects/task sidebar. #372 added a Coordination/Board toggle but kept the
  board landing + PROJECTS sidebar; the owner finds that navigation hard.
- **Epic:** [#359](https://github.com/gagan114662/agent-skills/issues/359) — make the reload.chat vision real.
- **Builds on:** [ADR-0352](0352-agent-coordination-surface.md) (re-mounted the orphaned reload.chat UI behind the
  default-OFF, owner-first `coordination-flag`), #372 (chat-first landing + the now-removed toggle),
  [ADR-0370](0370-agent-channel-bridge.md) (agent→channel messages), [ADR-0371](0371-department-roster.md)
  (named agent personas + the members-rail footer), [ADR-0035](0035-config-layering.md) (layered owner-first
  flags), [ADR-0013](0013-approval-gates.md)/[ADR-0243](0243-money-only-approval.md) (the #13 gate),
  [ADR-0200](0200-premortem-panel.md) (the premortem rails).

## Context

After #352/#372 the live app still landed on the board for the named owner, with a Coordination/Board toggle
and the projects/task sidebar (`StandupPanel`) always present. The owner wants the reload.chat surface to be
the **whole app**: a dark chat client — left rail of channels + people, a centre message feed + composer, a
right members rail — with flat navigation and no kanban.

Constraints carried from the epic and #200: **owner-workspace-first, default-OFF** (prod and other tenants
byte-for-byte unchanged until the owner opts in), **no new backend**, **no new action path** (every
irreversible/money action still stops at the #13 gate), reversible.

## Decision

Four web-only changes, all gated behind the existing `coordination-flag` (#352):

1. **CoordinationView IS the whole app for the flagged owner.** `ConsoleView` no longer renders the
   Coordination/Board toggle, the kanban board, or the `StandupPanel` projects/task sidebar when the gate is
   on — it renders `CoordinationView` alone (`.console--coord` collapses the two-pane grid to one column).
   `showCoordinationSurface = coordinationEnabled` (the `surfaceChoice`/tab state is gone). When the gate is
   **off**, `ConsoleView` renders the board byte-for-byte as today. Approvals stay reachable via the existing
   "N waiting on you" chip (→ the #13 PeekDrawer); Settings + Sign out move into the header because the
   sidebar that used to host them isn't rendered.

2. **ChannelSidebar rebuilt to the reload.chat structure:** a top search box (⌘K focuses it), then **PINNED**
   (owner-created channels outside the canonical department set), **CHANNELS** (the department channels +
   #general, canonical order), and **DIRECT MESSAGES** (humans **and** the seeded agent personas from the
   directory). The structure is a **pure projection** of the existing store
   (`coordination-nav.ts → buildSidebarModel`) — no new state on the wire. Selecting a DM resolves to that
   member's **existing** 1:1 channel via `resolveDmChannelId`: for an agent that is its **department
   channel** (in ipop you talk to Scout in #seo), which is the honest 1:1 surface without inventing a
   per-agent DM backend; the centre pane reframes its header as "Direct message with {name}" over that
   channel's real history. A DM that resolves to nothing is a safe no-op — we never create a channel.

3. **App-wide dark theme.** `theme.ts` stamps `<html data-theme="reload-dark">` from `main.tsx` **only when
   the coordination flag is on for this deployment**; `styles.css` overrides the brand colour tokens under
   `:root[data-theme="reload-dark"]`. Because the whole app keys off those tokens, this flips login,
   marketing landing, and console to one dark look in a single place — no per-component dark CSS. Default-OFF:
   prod sets no `VITE_RELOAD_COORDINATION_UI`, so no attribute is stamped and the paper palette renders
   byte-for-byte today's app. Reversible: unset the env, the override is gone.

4. **#370/#371/mission-control preserved.** Agent→channel messages render in the feed, the personas appear as
   DM targets and in the right rail, and the `MissionControlPanel` live strip sits above the chat — all
   unchanged, just inside the new layout.

## Why the theme is deployment-scoped (not per-workspace)

Login and the marketing landing render **before any workspace is known**, so a per-workspace gate could not
theme them. The theme therefore keys off the **build-time** `COORDINATION_UI_ENABLED` flag (the deployment
the owner runs with the env set), while the coordination **surface** keeps its full owner-workspace gate
(`shouldShowCoordination`). Prod sets no env, so this distinction never surfaces there. The prerendered
landing (`entry-server`) is not theme-stamped server-side; on the owner's dark preview the client applies the
theme on hydration (a one-paint flash on that preview only) — acceptable for a gated owner surface.

## #200 rails

- **DATA, not instructions:** channel/member/message strings are rendered as React text only (no
  `dangerouslySetInnerHTML`); the existing injection test (`<img onerror>` rendered verbatim) still holds.
  Search input and DM selection cannot widen scope — DM selection only ever resolves to an **existing**
  channel id, never mints one.
- **No new action path:** the surface is read + steer (chat) only. Every irreversible/money action still
  flows through the **#13** gate, reachable from the header's "waiting on you" control.
- **Fail-closed, owner-first, default-OFF, reversible:** unchanged from #352. Flipping the prod flag is
  owner-gated operational follow-up, not this PR.

## Alternatives considered

- **A real per-agent DM backend.** Rejected — violates "no new backend" and the epic's build+PR-only rail.
  Mapping an agent DM to its department channel is the honest existing-data 1:1.
- **Keep the Board reachable via a tab.** Rejected — the owner explicitly asked to remove the toggle and make
  chat the whole app. The board still renders for every non-flagged workspace (i.e. all of prod).
- **Global `:root` dark palette.** Rejected — it would change prod for everyone. The gated `data-theme`
  override leaves the default palette untouched.

## Consequences

- For the flagged owner workspace the app is a dark reload.chat client; for everyone else (all of prod) it is
  byte-for-byte today's board. Tests: `coordination-nav.test.ts`, `theme.test.ts` (+ the styles.css
  dark-token invariant), the rebuilt `ChannelSidebar.test.tsx`, `MessagePane.test.tsx` (DM framing), and the
  rewritten `ConsoleView.coordination.test.tsx` (whole-app, no board/toggle/sidebar). Full web suite green.
- Follow-ups (epic #359): the live coordination feed (#362) and backend coordination enablement (#361) make
  the channels populate in real time; this PR is the surface they light up.
