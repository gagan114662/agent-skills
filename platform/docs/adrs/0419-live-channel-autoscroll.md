# ADR-0419: Live channel auto-scroll — a working agent must never look dead

- **Status:** Accepted (web surface only; no flag, no backend, no migration — a perception/UX bugfix)
- **Date:** 2026-06-20
- **Context issue:** [#419](https://github.com/gagan114662/agent-skills/issues/419) — reproduced live (owner
  workspace, `#seo`, 2026-06-20). @scout ran real keyword research and posted a world-class, publish-ready
  deliverable as a channel message — confirmed present via `GET /channels/<seo>/messages` — but the owner saw
  **nothing** in the live UI until a manual page refresh. Owner's words: *"I don't see any response from the
  agent why?"* This is the single biggest reason the product feels broken even when the fleet is performing.
- **Epic:** [#359](https://github.com/gagan114662/agent-skills/issues/359) — make the reload.chat vision real
  (agents visibly coordinating + doing real, **visually auditable** work on the UI).
- **Builds on:** [ADR-0362](0362-live-coordination-feed.md) (the socket-driven live feed + poll fallback this
  mirrors), [ADR-0370](0370-agent-channel-bridge.md) / [ADR-0393] (the agent message/deliverable post path),
  [ADR-0352](0352-agent-coordination-surface.md) (the coordination surface), [ADR-0200](0200-premortem-panel.md)
  (content stays DATA).

## Context

The realtime path was **already correct** end-to-end: the agent's deliverable is posted via `channelPoster`,
which calls `publishMessageEvent` → Redis → the `/ws` gateway → the client socket; the store's `applyEvent`
upserts the `message` into `messagesByChannel`, and the existing test *"appends a realtime message without a
refresh"* proves the append works. So the data was reaching the client.

The defect was **purely visual**: `.messagelist` is a top-aligned `overflow-y:auto` flex column with **zero
scroll management**. On channel open it sits at `scrollTop = 0` (oldest first), and a newly-arrived agent
message lands at the *bottom*, below the fold. The feed never scrolled to it on open or on arrival, and there
was no "new messages" affordance — so a fully-working agent's reply was invisible, read as "no response."

A second, compounding gap: there was **no message-level poll fallback** for the open channel (only
mission-control had one, #362). If a socket event is ever dropped — or the socket never connects in a flaky /
cross-site context ([#418](https://github.com/gagan114662/agent-skills/issues/418)) — the channel strands until
a manual refresh, which is exactly the literal symptom reported.

## Decision

Mirror the #362 architecture (pure decision module + hook + view wiring), web-only, no backend:

1. **`message-scroll.ts` (pure):** `isNearBottom(metrics)` and `decideOnNewMessages({added, wasNearBottom,
   authoredBySelf}) → "scroll" | "notify" | "none"`. A reader at the bottom (or who just sent a message)
   auto-follows; a reader who scrolled up into history is **notified, never yanked**.
2. **`MessagePane` wiring:** a `ref` on the scroller + a `useLayoutEffect` that jumps to the newest message on
   channel open and on a new arrival per the pure decision, plus a floating **"N new messages ↓" pill** when the
   reader is scrolled up. Scrolling uses `scrollTop = scrollHeight` (jsdom-safe).
3. **`useLiveChannelMessages` hook + `store.refreshChannelMessages`:** a poll **fallback** for the open channel
   that re-fetches and **upserts** (never clobbers a live arrival), reusing the shared #362 pure
   `shouldRefetchMission` timing decision — socket proven live → slow heartbeat floor; socket down → poll every
   tick. So a dropped/never-delivered realtime message self-heals within seconds without a manual refresh.

## Safety (#200)

Read + steer only. No new request surface beyond the channel's existing `listMessages`, no money/irreversible
action path (the #13 gate is untouched). Message content stays DATA — rendered as React text — and the scroll
layer only decides intent from numbers (`scrollTop`/`scrollHeight`/`clientHeight`); it never interprets a
payload.

## Consequences

- A briefed agent's reply now appears **live and in view** — the core "visually auditable work" the reload.chat
  vision (#359) needs. The owner watches the work happen instead of refreshing to discover it.
- Defense-in-depth: even when the socket is degraded (the #418 case), the channel stays fresh on its own.
- No flag: this is a straight bugfix to today's behaviour (the surface was already shipped), so it applies to
  every workspace that can see a channel.

## Verification

`message-scroll.test.ts` (pure: near-bottom + decide matrix), `MessagePane.test.tsx` (auto-follow at bottom →
no pill; scrolled-up arrival → pill → click clears), `store.test.ts` (`refreshChannelMessages` upsert merges a
live arrival, swallows a fetch error). Gates green: **tsc ✓, eslint ✓, web vitest 621/621 ✓, build ✓.**
