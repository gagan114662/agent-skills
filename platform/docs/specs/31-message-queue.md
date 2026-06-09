# Spec 31 — Composer message / steering queue (#54)

## Goal
Give the web composer a **per-session message queue**: a user can stack several messages for the
active conversation, edit/reorder/delete them before they send, navigate them by keyboard, and choose
how each goes out — **send now**, **queue** (after what's already pending), or **steer** (jump ahead
of the queue). The queue **pauses while you edit** so an in-flight drain can't send a half-typed
message.

## Background
Conductor's composer queue is a control loop *above* the agent: you line up instructions, the agent
drains them one at a time, and you can re-order or steer between turns. Reload has a server-side
**task** queue (#14) but nothing at the composer level — every keystroke posts immediately. This issue
adds the composer-level loop, web-only, on top of the real harness (#50).

"Session" here is the **active channel** — each channel keeps its own independent queue, so switching
channels and coming back preserves what you stacked. There is **no new server contract**: the queue is
client-only state in the single app store (ADR-0018's one-store pattern); each item is sent through the
existing `POST /channels/:id/messages` path the composer already uses.

### Known platform constraint — there is no "agent busy/ready" wire signal
The WebSocket protocol (`api/types.ts`) has no per-agent busy/idle event. We therefore model
"the agent is ready for the next message" with the **honest local proxy available to a chat client**:
the queue drains **one message at a time, each send awaiting the previous post's completion**. This
satisfies "queued messages send in order when the agent is ready" without overclaiming a readiness
signal the server doesn't emit. If a real busy/idle signal arrives later (a follow-up to #50's
`stream-json` parsing), the drain gate swaps in with no UI change.

## Design
A pure queue module plus a store slice and one UI surface.

### Queue model (`store/queue.ts`, pure + unit-tested)
```
type QueueItemKind = "queue" | "steer";
interface QueueItem { id: string; text: string; kind: QueueItemKind; }
interface SessionQueue { items: QueueItem[]; status: "idle" | "sending" | "paused"; editingId: string | null; }
```
Pure reducers (no I/O, no React): `enqueue`, `enqueueSteer`, `removeItem`, `moveItem(up|down)`,
`beginEdit`, `editText`, `commitEdit`, `cancelEdit`, and `takeHead` (pop the next item to send).
- **queue** appends to the tail.
- **steer** inserts ahead of all `queue` items but after any existing steers — steers preserve their
  own order and collectively preempt the queued backlog (Conductor's "redirect now" semantics).
- **beginEdit** sets `status:"paused"` and records `editingId` (+ keeps the original text for cancel);
  `commitEdit`/`cancelEdit` clear `editingId` and restore `status:"idle"`.

### Store slice (`store/store.ts`)
`queues: Record<string /*channelId*/, SessionQueue>` on `AppState`. Actions are channel-scoped to the
active channel: `queueMessage`, `steerMessage`, `editQueuedStart/Change/Commit/Cancel`, `removeQueued`,
`moveQueued`. A private `drain(channelId)` loop runs while `status==="idle"` and the queue is non-empty:
it flips to `sending`, pops the head with `takeHead`, `await api.postMessage(...)`, then loops. `paused`
(an active edit) stops the next iteration; committing/cancelling the edit re-arms the drain. Sending
through the same path as `sendMessage` means realtime echo + `upsertMessage` already render the result.

### UI (`components/MessageQueue.tsx`, rendered by the channel `Composer`)
A list above the input showing each pending item, its kind badge (Queued / Steer), and per-item
**↑ ↓ Edit ✕** controls; editing swaps the row for an inline textarea (Save / Cancel). The composer
gains **Queue** and **Steer** actions next to **Send**. Keyboard model on the input/list:
- Empty input + **Enter** / **Send** → send now (unchanged).
- **⌘/Ctrl+Enter** → Queue;  **⌥/Alt+Enter** → Steer.
- In the list: **↑ / ↓** move selection, **⌥+↑ / ⌥+↓** reorder, **Enter** edit, **Delete/Backspace**
  remove, **Esc** cancel an edit (restoring the partial→original text).

## In scope
- `store/queue.ts` pure model + reducers, fully unit-tested.
- Queue slice + channel-scoped actions + the one-at-a-time drain in `store/store.ts`.
- `MessageQueue.tsx` UI + composer wiring (Queue / Steer buttons, keyboard nav, pause-on-edit).
- Per-channel persistence (queue survives channel switches within a session).

## Out of scope
- Cross-session broadcast / sending one message to many channels (explicitly out per the issue).
- Persisting the queue across reloads (localStorage) or to the server.
- A real agent busy/idle wire signal (follow-up to #50 stream parsing).

## Acceptance
- Queued messages send **in order**, one at a time, each after the prior post resolves.
- **Steer** preempts queued items (sends ahead of them); **queue** lands behind them — observably distinct.
- **Editing** a queued item preserves its partial text and **pauses** the drain; commit/cancel resumes.
- Reorder (↑/↓) and delete work from both mouse and keyboard.
- Each channel keeps an independent queue across channel switches.
- Tests first (Red→Green); all gates green (`typecheck && lint && test && build`); no server files touched.
- ADR-0031 records the client-only, no-readiness-signal queue design.
- Demo video: queue / edit / reorder / steer at `platform/docs/demos/31-message-queue.mp4`.
