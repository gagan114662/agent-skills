# ADR-0362: Live coordination feed — replace the 4s mission-control poll with real-time websocket delivery

- **Status:** Accepted (web-only; no backend change, no production flag flipped)
- **Date:** 2026-06-19
- **Context issue:** [#362](https://github.com/gagan114662/agent-skills/issues/362) — the re-mounted
  coordination surface (#352 / PR #354) is backed by a fixed ~4s poll, not real-time updates, so agents
  coordinating "live" actually lag up to four seconds and the poll fires even when idle.
- **Epic:** [#359](https://github.com/gagan114662/agent-skills/issues/359) — make the reload.chat vision real;
  this is sub-issue (2), the visible-coordination half of the DoD.
- **Builds on:** [ADR-0352](0352-agent-coordination-surface.md) (the re-mounted UI + `coordination-flag.ts`),
  [ADR-0005](0005-realtime-messaging.md) (the Redis pub/sub realtime gateway over `/ws`), #147 (mission-control
  seam), [ADR-0200](0200-premortem-panel.md) (the premortem rails), [ADR-0370](0370-agent-channel-bridge.md)
  (the agent→channel bridge that produces the handoff messages this feed streams).

## Context

The coordination surface renders `MessagePane` (channel messages), `MembersRail` (members/presence) and a
`MissionControlPanel` live strip (the #147 running-sessions roll-up). Auditing the actual data paths:

- **Messages already arrive live.** The store consumes the `/ws` socket once (`realtime.on(onEvent)` in
  `loadWorkspace`) and applies `message`/`mention`/`presence` events to state immediately. A new message in the
  subscribed channel appears with no poll — proven by `MessagePane.test.tsx` ("appends a realtime message
  without a refresh"). Messages are **not** polled at all.
- **The mission-control strip was the real 4s gap.** `MissionControlPanel` ran its own
  `setInterval(refresh, 4000)`, and `ConsoleView` ran a second 4s mission-control poll for the board. New
  agent **sessions / handoffs** (a delegation spawns a session) only showed up on that fixed cadence — and the
  poll fired every 4s even when nothing changed.

So "make coordination real-time" is concretely: **drive the mission-control strip off websocket events**, keep
messages/presence as they already are (live), and keep polling only as a fallback.

### Premortem (#200) obligations

- **§4 reversibility / no new action path:** read + steer only. This change adds NO money/irreversible action;
  the #13 approval gate is untouched. It only decides *when to refetch a read-only roll-up*.
- **§6 untrusted content:** streamed channel/message content stays **DATA** — rendered as React text, never
  `dangerouslySetInnerHTML` (the #352 invariant, covered by `CoordinationView.test.tsx`). Nothing in this
  change ever interprets a payload; the timing layer is payload-blind.
- **Fail-closed:** a socket outage degrades to the existing poll at the exact prior cadence — never to an open
  surface and never to anything slower than today.

## Decision

A **web-only** change, in three pure/testable pieces, with **zero new backend** (the `run_status` / `message`
events it consumes already broadcast over `rt:channel:<id>` per ADR-0005):

### 1. A pure timing layer — `apps/web/src/components/console/mission-live.ts`

- `isMissionLiveEvent(type)` — which realtime events mean "the strip may have changed": `message` (a handoff/
  delegation posts a message), `run_status` / `deploy_status` (session lifecycle), `notification`. Presence and
  mentions are excluded — the store already applies them live, so refetching on them would be noise. The list
  is `satisfies readonly ServerEvent["type"][]`, so a renamed/removed event fails the build.
- `shouldRefetchMission({ nowMs, lastEventAtMs, lastFetchAtMs })` — the poll-**fallback** gate, pure and
  clock-free: socket not proven live ⇒ refetch every tick (== today's 4s); socket live ⇒ skip, except a slow
  30s heartbeat floor so a dropped event can never strand the strip.

### 2. A store seam — `store.onRealtimeEvent(listener)`

The store already owns the single socket. `onEvent` now applies the event to state (`applyEvent`) **and** fans
it out to external `onRealtimeEvent` subscribers — so a view can react live without opening a second socket. A
throwing subscriber can never stall the socket pump (wrapped in try/catch).

### 3. A hook — `useLiveMissionControl(workspaceId)`, wired into `MissionControlPanel`

- **Primary (real-time):** subscribes via `store.onRealtimeEvent` and refetches the instant a mission-relevant
  event lands — a delegation/handoff shows within the socket round-trip, no 4s wait.
- **Fallback (poll):** a base tick at the prior `MISSION_POLL_FALLBACK_MS = 4000` asks `shouldRefetchMission`
  whether to refetch — every tick when the socket is down (today's behaviour), a 30s heartbeat when it is live.

`MissionControlPanel`'s fixed 4s interval is removed; the panel now reads the hook. Because that panel only
mounts inside `CoordinationView`, the new behaviour is **already gated** by `coordination-flag.ts`
(default-OFF, owner-workspace-first): with the prod env unset, the surface never mounts, so production is
**byte-for-byte today's board**.

## Consequences

- New agent messages, handoffs/delegations and session-status changes appear in the coordination view within
  the socket round-trip instead of up to 4s later, and the idle poll storm is gone (a 30s heartbeat while live).
- **Graceful degrade:** when the socket is unavailable the strip falls back to the exact prior 4s poll — never
  worse than today.
- **What this PR does NOT do:** it does not change the server, add a migration, add an action path, or flip any
  production flag (`VITE_RELOAD_COORDINATION_UI` / `fly.toml` untouched). Fully reversible.
- **Acceptance (#362):** `CoordinationView.live.test.tsx` fires a `message` event over the realtime seam and
  asserts (a) it shows in the feed live and (b) the same event refetches the mission-control strip — both
  inside a sub-second window, far under the 4s poll, so the socket (not a timer) is what updated the surface.
- **Out of scope / follow-up:** the sidebar reflects activity live only for channels the store has subscribed
  to (the active channel); multi-channel sidebar liveness (subscribing every department channel) is a larger,
  server-fan-out-touching change left for a follow-up. `ConsoleView`'s separate board mission-control poll is
  left as-is (the board is not the owner's surface when coordination is the whole app, #378).
