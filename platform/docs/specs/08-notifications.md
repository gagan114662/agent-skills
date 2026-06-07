# Spec: Reload Platform — Notifications & activity alerts (Issue #8)

> Implements [#8](https://github.com/gagan114662/agent-skills/issues/8). Phase 1 — Core chat. Depends on #6 (mentions), builds on #4 (channels/DMs), #5 (realtime), #9 (RBAC), #14 (tasks).
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Pre-approved by Gagan for end-to-end execution through PR (no merge without review + video).

## Objective
**What:** An in-app **notification inbox** with **unread tracking**, delivered **live** over the
#5 WebSocket gateway. A notification is a durable, per-recipient record of an activity event:
a member is `@mentioned` (#6), receives a **DM** message, gets a **reply** to a thread they
started, or is **assigned** a task (#14). Each member reads **their own** notifications, sees an
**unread count**, and **marks them read**. Per-member **preferences** (`mute`, `mention-only`)
gate which notifications are created, and a pluggable **external transport** (no-op default,
webhook example) lets a deployment forward notifications off-platform.

**Why:** #6 made conversations *addressable* (an `@mention` lands as a realtime event), but a
mention event is ephemeral — miss the socket and it's gone, and it only covers mentions. #8 adds
the **durable activity surface** reload.chat needs: an inbox a human (or agent) can come back to,
an unread badge, and a single seam that turns *any* relevant activity (mention, DM, reply,
assignment) into a notification — in-app and, optionally, pushed to an external system.

**Who:** Humans (session cookie) and agents (Bearer token) — both are `members`, both accrue
notifications, both receive `notification` events over the same #5 socket. An `@agent` mention or
a task auto-routed to an agent becomes an actionable notification on the agent's inbox + socket.

### Acceptance criteria (from #8)
- **Mention / DM / assignment → live inbox notification** — these activities create a durable
  notification for the recipient and push a realtime `notification` event to their sockets.
- **Muting suppresses non-mention notifications** — `mention-only` preference suppresses every
  non-`mention` notification (DM, reply, assignment); `mute` suppresses everything.
- **Mark-read clears unread** — marking a notification (or all) read drops it from the unread
  count; the row persists in the inbox with `read_at` set.
- **Webhook adapter documented + tested** — the external transport interface ships with a no-op
  default and a webhook adapter, unit-tested (payload shape + delivery via an injected fetch).
- A notification rides the **#5 WS gateway** (extend the `ServerEvent` union, no break).
- Everything stays **workspace-scoped** (#3 IDOR) and respects **#9** read; a member only ever
  sees **their own** notifications (no cross-member, no cross-workspace leakage).

### Out of scope (deferred)
- **Approval-request notifications.** The issue lists "approval requests" as a trigger, but no
  approval primitive exists in the merged platform yet. The `approval` notification *type* is
  reserved in the model + transport so the surface is complete, but **no in-repo trigger emits
  it** — it's wired when an approval primitive lands. (Noted in ADR-0008.)
- **Per-channel read cursors / "N unread messages in #channel".** #8 ships a notification inbox
  (discrete activity records), not a last-read-per-channel message cursor. (Future work.)
- **Digest / batching / rate-limiting / quiet-hours.** Preferences are `mute` + `mention-only`
  only; scheduled digests and per-type granular toggles are future work.
- **Notification deletion / archival, retry queue for the external transport.** External delivery
  is best-effort fire-and-forget (logged on failure); a durable outbox/retry is future work.
- **Re-notification on message edit.** Like #6, notifications are derived at the activity moment.

## Notification model
A notification is one row per **recipient** per **activity**. It carries the recipient, a `type`,
the actor who caused it, the relevant references (channel/message for chat activity, task for task
activity), a short `excerpt` snapshot (so the inbox renders without joins and survives source
deletion), and `read_at` (null = unread).

- **Types:** `mention` | `dm` | `reply` | `assignment` (+ reserved `approval`, no trigger yet).
- **Inbox:** `GET /me/notifications` — the caller's notifications, newest first. `?unread=true`
  filters to unread only.
- **Unread count:** `GET /me/notifications/unread-count` → `{ count }`.
- **Mark one read:** `POST /me/notifications/:nid/read` — 404 if the notification isn't the
  caller's (the IDOR guard; recipient scoping). Idempotent.
- **Mark all read:** `POST /me/notifications/read-all` → `{ marked }`.

## Preferences (mute / mention-only)
Per-member preferences gate notification **creation** (a suppressed notification is never written
and never pushed):
- `muted` — suppress **all** notifications, including mentions.
- `mentionOnly` — suppress every **non-`mention`** notification (DM, reply, assignment); mentions
  still come through.
- Default (no row) — every notification is delivered.

The gate is a pure function `shouldNotify(type, prefs)` (unit-tested):
`muted ⇒ false`; else `mentionOnly ⇒ type === "mention"`; else `true`.

- **Read prefs:** `GET /me/notification-preferences` → `{ muted, mentionOnly }` (defaults when no
  row).
- **Set prefs:** `PUT /me/notification-preferences` — body `{ muted?, mentionOnly? }`, upsert.

## Triggers (where notifications are created)
Wired at the route/service layer (best-effort, never failing the REST write that already
succeeded — same publish-on-write discipline as #5/#6). The author/actor is never notified of
their own action.
- **mention** — in `extractAndNotifyMentions` (#6), for each persisted mention create a
  `mention` notification for the mentioned member (in addition to the existing #6 `mention` event).
- **dm** — posting a message to a channel of `kind = "dm"` creates a `dm` notification for each
  *other* DM member.
- **reply** — posting a thread reply creates a `reply` notification for the thread **root's
  author** (if not the replier).
- **assignment** — assigning a task to a member (via create-with-assignee, `POST …/assign`, or
  auto-route) creates an `assignment` notification for the new assignee (if the assignee actually
  changed and isn't the actor).

## Transport (external delivery, pluggable)
A `NotificationTransport` interface decouples *creating* a notification from *forwarding* it
off-platform:
```ts
interface NotificationTransport { deliver(n: NotificationRecord): Promise<void>; }
```
- **`NoopTransport`** — the default; does nothing. Tests and CI need no external endpoint.
- **`WebhookTransport`** — POSTs `buildWebhookPayload(n)` (a stable `{ event:"notification",
  notification:{…} }` JSON) to a configured URL. Uses an injectable `fetch` so it's unit-tested
  without a network. Selected when `NOTIFY_WEBHOOK_URL` is set (`selectTransport(env)`).

External delivery is best-effort and fire-and-forget inside the notify service: a webhook failure
is logged, never fails the in-app notification or the REST write.

## Transport & protocol (extends #5, non-breaking)
`ServerEvent` gains one variant:
```jsonc
{ "type": "notification", "notification": {
    id, type, recipientMemberId, actorMemberId, channelId, messageId, taskId, excerpt, createdAt } }
```
- A `notification` is delivered to the **recipient's** sockets regardless of channel subscription
  — exactly like a #6 `mention`. New Redis key `rt:notify:{workspaceId}` carries `notification`
  events; the gateway reuses its per-member socket index (`byMember`) and forwards a notification
  only to the recipient's sockets in that workspace. No client command changes; clients just
  receive a new event type. (The #6 `mention` event is unchanged — a mention now produces *both*
  a `mention` event and a durable `notification`.)

## Data model (additive migration `0007_notifications`)
Numbered `0007` — the next free number after `0006_threads_mentions` (`0025_agent_sessions` is a
sibling branch's reserved number). Additive: two new independent tables, no change to existing
tables. Up + paired down.
```sql
CREATE TABLE notifications (
  id                   uuid PRIMARY KEY,
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_member_id  uuid NOT NULL REFERENCES members(id)    ON DELETE CASCADE,
  type                 text NOT NULL,                 -- mention | dm | reply | assignment | approval
  actor_member_id      uuid REFERENCES members(id)    ON DELETE SET NULL,
  channel_id           uuid REFERENCES channels(id)   ON DELETE CASCADE,
  message_id           uuid REFERENCES messages(id)   ON DELETE CASCADE,
  task_id              uuid REFERENCES tasks(id)      ON DELETE CASCADE,
  excerpt              text,
  read_at              timestamptz,                   -- null = unread
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_recipient_idx ON notifications (recipient_member_id, created_at);
-- fast unread count / unread filter
CREATE INDEX notifications_unread_idx ON notifications (recipient_member_id) WHERE read_at IS NULL;

CREATE TABLE notification_preferences (
  member_id    uuid PRIMARY KEY REFERENCES members(id)     ON DELETE CASCADE,
  workspace_id uuid NOT NULL    REFERENCES workspaces(id)  ON DELETE CASCADE,
  muted        boolean NOT NULL DEFAULT false,
  mention_only boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```
- **down:** drop both tables (+ indexes).

## Code layout
- `src/notifications/types.ts` — pure: `NotificationType` union, `isNotificationType`,
  `NotificationPrefs`, `shouldNotify(type, prefs)`. No DB. Unit-tested.
- `src/notifications/transport.ts` — `NotificationTransport`, `NoopTransport`, `WebhookTransport`
  (injectable fetch), `buildWebhookPayload`, `selectTransport`, memoized `getNotificationTransport`.
- `src/notifications/service.ts` — `notify(log, input)`: read prefs → `shouldNotify` gate →
  `createNotification` → publish WS `notification` → fire-and-forget external transport. Never
  throws (best-effort).
- `src/db/schema/notifications.ts` — `notifications` + `notificationPreferences` tables (exported
  from schema index).
- `src/db/repositories/notifications.ts` — `createNotification`, `listNotificationsForMember`,
  `countUnread`, `markRead`, `markAllRead`, `getPreferences`, `upsertPreferences`.
- `src/db/repositories/channels.ts` — add `listChannelMemberIds(channelId)` (DM fan-out).
- `src/realtime/protocol.ts` — `NotificationEvent` type + `notification` variant on `ServerEvent`.
- `src/realtime/bus.ts` — `NOTIFY_KEY_PREFIX` / `NOTIFY_PATTERN`, `notifyKey`,
  `workspaceIdFromNotifyKey`, `publishNotification`.
- `src/realtime/gateway.ts` — `PSUBSCRIBE` the notify pattern; forward `notification` events to the
  recipient's sockets via the existing `byMember` index.
- `src/routes/notifications.ts` — `GET /me/notifications`, `…/unread-count`,
  `POST …/:nid/read`, `…/read-all`, `GET|PUT /me/notification-preferences`.
- `src/routes/channels.ts` — trigger mention/dm/reply notifications on post + reply.
- `src/routes/tasks.ts` — trigger assignment notifications on create-with-assignee + assign.
- `src/env.ts` — optional `notify.webhookUrl` from `NOTIFY_WEBHOOK_URL`.
- `src/app.ts` — register `notificationRoutes`.

## Testing strategy
- **Unit (`test/unit/notifications.test.ts`, no Redis/DB):**
  - `shouldNotify`: default (all pass), `muted` (all suppressed incl. mention), `mentionOnly`
    (only mention passes), and combinations.
  - `isNotificationType` guard (valid types true; unknown false).
  - `buildWebhookPayload` shape; `WebhookTransport.deliver` calls the injected fetch with the
    right URL + JSON body; `NoopTransport.deliver` resolves without side effects;
    `selectTransport` → noop by default, webhook when `NOTIFY_WEBHOOK_URL` set.
  - Protocol parser stays green (existing `realtime-protocol` test unaffected).
- **Integration (real Postgres + Redis, `test/integration/notifications.test.ts`):**
  1. **@mention → live notification + inbox + unread:** human mentions an agent → agent's WS
     receives a `notification` event (type `mention`); `GET /me/notifications` shows it (unread);
     `…/unread-count` = 1. (The #6 `mention` event still fires — non-breaking.)
  2. **DM → notification to the other member:** A and B share a DM; A posts → B's WS receives a
     `dm` notification and B's inbox shows it; A (author) gets none.
  3. **assignment → notification:** create a task assigned to an agent → the agent gets an
     `assignment` notification.
  4. **mention-only suppresses non-mention:** B sets `mentionOnly` → a DM to B creates **no**
     notification, but an `@B` mention still does.
  5. **mute suppresses all:** B sets `muted` → even an `@B` mention creates nothing.
  6. **mark-read clears unread:** unread-count = N; `POST …/read-all` → unread-count = 0; the
     inbox still lists them with `read_at` set; `POST …/:nid/read` marks one.
  7. **isolation:** A's inbox never contains B's notifications; a member in another workspace sees
     none (mirrors the #3 cross-tenant test).
- Runs in the existing `integration` CI job (Postgres + Redis service containers).

## Quality gates (must pass before PR)
From `platform/`: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`, plus
`pnpm --filter @reload/server test:integration` against real Postgres + Redis.

## Boundaries
- **Always:** scope every notification + preference read/write by `identity.workspaceId` and the
  caller's `memberId` (the recipient is always the caller on the read side); keep REST the source
  of truth (create-then-publish, best-effort); never notify the actor of their own action; gate
  creation through `shouldNotify`; write the failing test first; attach a demo + ADR.
- **Ask first:** adding per-channel read cursors (separate surface); adding granular per-type
  preference toggles or digests; wiring an `approval` trigger (needs an approval primitive); any
  new dependency; a durable external-delivery retry/outbox.
- **Never:** deliver a `notification` event to anyone but the recipient; leak notifications across
  members or workspaces; let the external transport failure fail the in-app notification or the
  REST write; require Redis/an external endpoint for the REST/`inject` path or the no-Redis
  `quality` job; merge without approval + video.

## Success criteria
1. A mention, a DM, and a task assignment each create a durable notification and push a
   `notification` WS event to the recipient (integration-tested).
2. `mentionOnly` suppresses non-mention notifications; `muted` suppresses all (integration-tested).
3. `GET /me/notifications` + `…/unread-count` + `POST …/:nid/read` + `…/read-all` work, recipient-
   and workspace-scoped, with no cross-member/cross-workspace leakage (integration-tested).
4. The transport interface ships with a no-op default + a webhook adapter, unit-tested.
5. All quality gates green (typecheck, lint, unit, build) + integration green; **video**
   `platform/docs/demos/08-notifications.mp4` + **ADR-0008**.

## Decisions (resolved — pre-approved for end-to-end execution)
1. **Notification = durable per-recipient record; a mention now yields both a #6 `mention` event
   and a #8 `notification`.** The ephemeral mention event is kept (non-breaking); the durable
   notification is the inbox/unread surface. → ADR-0008.
2. **Preferences gate creation, not delivery.** A suppressed notification is never written and
   never pushed (cheaper, and the inbox stays a true record of delivered notifications). The gate
   is one pure `shouldNotify`. → ADR-0008.
3. **Recipient-targeted delivery via `rt:notify:{wid}` + the existing `byMember` index.** Reuses
   the #6 mention-delivery seam; a notification reaches only the recipient's sockets. → ADR-0008.
4. **Explicit nullable FK references (channel/message/task) + an `excerpt` snapshot,** rather than
   a generic `(subject_type, subject_id)`. FKs give cascade cleanup; the excerpt keeps the inbox a
   single-table read that survives source deletion. → ADR-0008.
5. **Triggers wired at the route/service layer, best-effort.** Repositories stay pure DB (no Redis
   / transport imports); the `notify` service composes pref-gate + persist + publish + external,
   and never fails the REST write. → ADR-0008.
6. **External transport is a pluggable interface (no-op default, webhook example), fire-and-forget.**
   A durable retry/outbox is deferred. → ADR-0008.
7. **`approval` type reserved, not triggered.** No approval primitive is merged; the type exists in
   the model/transport so the surface is complete, but nothing emits it yet. → ADR-0008.
</content>
</invoke>
