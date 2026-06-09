# ADR-0031 — Composer message / steering queue (client-only, single-drain)

**Status:** Accepted · **Issue:** #54 · **Date:** 2026-06-09

## Context
Conductor's composer queue is a control loop *above* the agent: you stack instructions, the agent
drains them one at a time, and you can edit / reorder / delete them or **steer** (redirect now)
between turns. Reload had a server-side **task** queue (#14) but nothing at the composer level — every
keystroke posted immediately. #54 adds the composer loop on top of the real harness (#50). It is
web-only and must not touch the server contract.

Two facts shaped the design:
1. **There is no agent busy/idle wire signal.** The WebSocket protocol (`api/types.ts`) carries
   `message` / `mention` / `presence` / `notification` events but nothing that says "the agent is
   ready for the next instruction."
2. **The app is one in-memory store** (ADR-0018), no router/Redux, immutable `set`.

## Decision
A **client-only** per-session queue, where "session" = the **active channel**.

- **Pure model** (`store/queue.ts`): `SessionQueue { items, status: "idle"|"paused", editingId,
  editOriginal }` with immutable reducers (`enqueue`, `enqueueSteer`, `moveItem`, `beginEdit`,
  `editText`, `commitEdit`, `cancelEdit`, `takeHead`). **Steer** inserts ahead of the queued backlog
  but behind earlier steers; explicit reorder is authoritative thereafter.
- **Store slice**: `queues: Record<channelId, SessionQueue>` + channel-scoped actions. A private
  `drain(channelId)` sends one message at a time through the **existing** `postMessage` path, so
  realtime echo + `upsertMessage` render the result with zero new server surface.
- **"Agent ready" proxy**: the drain awaits each post before sending the next. One message in flight
  at a time *is* the honest readiness signal a chat client has. If a real busy/idle event lands later
  (a follow-up to #50's `stream-json` parsing), it swaps in at the drain gate with no UI change.
- **UI** (`MessageQueue.tsx`, mounted by the channel `Composer` behind a `queue` prop): the pending
  list with kind badges, inline edit, ↑/↓ reorder, delete, and keyboard nav. `⌘/Ctrl+Enter` queues,
  `⌥/Alt+Enter` steers, plain Enter still sends now. Thread replies stay a plain send box.

## Why this shape
- **In-flight tracked in a closure `Set`, not in `SessionQueue.status`.** This was the key call. An
  earlier design encoded `"sending"` as a third status; committing an edit *while a send was in
  flight* then clobbered the status and could start a **second** concurrent send. Moving the in-flight
  flag to a `draining` guard in the store makes the loop the single sender — re-entrant `queue` /
  `steer` / edit-commit calls all fold into the one running drain. `status` is now only the pure,
  testable `idle | paused` an edit toggles.
- **Pure model split out** so ordering, steer-preemption, and pause-on-edit are unit-tested without
  React or async (`queue.test.ts`); the store test (`queue-store.test.ts`) gates `postMessage` to
  prove one-at-a-time ordering and that an open edit halts the drain.
- **No persistence / no server.** Per the issue, cross-session broadcast is out; localStorage and a
  server queue are deferred — the slice is the seam if they're ever wanted.

## Consequences
- The queue is in-memory: a reload clears it (acceptable; matches "draft" semantics).
- Readiness is approximated by "previous post resolved." When the harness emits real turn boundaries,
  the drain gate is the one place to upgrade.
- Steer is a *client-side reordering* of un-sent messages, not a mid-turn interrupt of an already
  running agent turn — that deeper interrupt belongs with #50 stream parsing, not this UI loop.

## Alternatives considered
- **Encode `sending` in `SessionQueue.status`** — simpler types, but it conflated "an edit paused us"
  with "a network send is in flight" and opened the double-send race above. Rejected.
- **A new server-side composer-queue endpoint** — would add a contract for state that is inherently
  client/draft-shaped and is explicitly out of scope. Rejected.
