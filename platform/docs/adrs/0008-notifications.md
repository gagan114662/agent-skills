# ADR-0008: Notifications & activity alerts

- **Status:** Accepted (Gagan pre-approved end-to-end execution — issue #8)
- **Date:** 2026-06-07
- **Context issue:** [#8](https://github.com/gagan114662/agent-skills/issues/8)
- **Builds on:** [ADR-0004](0004-channels-dms.md), [ADR-0005](0005-realtime-messaging.md), [ADR-0006](0006-threads-mentions.md), [ADR-0009](0009-registry-rbac.md), [ADR-0014](0014-tasks.md)

## Context
#6 made conversations *addressable*: an `@mention` resolves to a workspace member and lands as a
realtime `mention` event on that member's socket. But that event is **ephemeral** — miss the
socket and it's gone — and it only covers mentions. reload.chat needs a durable **activity
surface**: an inbox a human or agent can come back to, an **unread** badge, a single seam that
turns *any* relevant activity (mention, DM, thread reply, task assignment) into a notification,
per-member control over the noise, and an optional hook to forward notifications off-platform.
This is #8. It must ride the existing #5 event stream without breaking it, stay workspace-scoped
(#3 IDOR), and never leak one member's notifications to another.

## Decisions

1. **A notification is a durable, per-recipient record; a mention now yields *both* a #6 `mention`
   event and a #8 `notification`.** The ephemeral mention event is kept unchanged (non-breaking
   for #6 clients); the notification is the new inbox/unread surface. Each notification row carries
   the recipient, a `type` (`mention` | `dm` | `reply` | `assignment`), the actor, the relevant
   references, a short `excerpt` snapshot, and `read_at` (null ⇔ unread). The inbox
   (`GET /me/notifications`, `?unread=true`), unread count (`…/unread-count`), and mark-read
   (`POST …/:nid/read`, `…/read-all`) are all scoped to the caller as recipient.

2. **Preferences gate *creation*, not delivery.** Two per-member toggles — `muted` (silence all)
   and `mentionOnly` (keep only mentions) — are applied by one pure function
   `shouldNotify(type, prefs)` *before* a row is written. A suppressed notification is never
   persisted and never pushed (cheaper; and the inbox stays a true record of what was delivered).
   `muted` wins over `mentionOnly`. Defaults (no row) deliver everything.
   `GET|PUT /me/notification-preferences` read/upsert them.

3. **Recipient-targeted realtime delivery via `rt:notify:{workspaceId}` + the existing `byMember`
   socket index.** This reuses the #6 mention-delivery seam exactly: the gateway `PSUBSCRIBE`s
   `rt:notify:*` alongside the channel/presence/mention patterns and forwards a `notification` only
   to the recipient member's sockets, independent of channel subscription. The `ServerEvent` union
   gains one additive `{type:"notification", notification}` variant — no breaking change to #5/#6
   clients, and no new client command.

4. **Explicit nullable FK references (`channel_id`, `message_id`, `task_id`) plus an `excerpt`
   snapshot, rather than a generic `(subject_type, subject_id)`.** The FKs give referential
   integrity and `ON DELETE CASCADE` cleanup (a deleted channel/message/task takes its
   notifications with it; a deleted actor is `SET NULL`). The `excerpt` keeps the inbox a
   single-table read that still renders if the source is later deleted. Two reference domains
   (chat: channel+message; task) cover every #8 trigger without a polymorphic join.

5. **Triggers are wired at the route/service layer, best-effort — repositories stay pure DB.** A
   single `notify(log, input)` service composes the steps: preference gate → persist → publish WS
   → forward to the external transport. It **never throws** (errors are logged), so a Redis/DB/
   webhook hiccup never fails the REST write that already succeeded — the same publish-on-write
   discipline as #5/#6. The row + WS publish are awaited before the route responds (so the inbox is
   immediately consistent); the external transport is fire-and-forget. The actor is never notified
   of their own action (`notify` no-ops when `actor == recipient`). Triggers:
   - **mention** — in `extractAndNotifyMentions` (#6 reuse), per resolved mention.
   - **dm** — posting to a `kind="dm"` channel notifies the other member(s).
   - **reply** — a thread reply notifies the thread root's author.
   - **assignment** — create-with-assignee / `POST …/assign` / auto-route notifies the new assignee.

6. **External transport is a pluggable interface (no-op default, webhook example), fire-and-forget.**
   `NotificationTransport.deliver(record)` decouples in-app notifications from off-platform
   delivery. `NoopTransport` is the default (tests/CI need no endpoint); `WebhookTransport` POSTs a
   stable `{event:"notification", notification}` JSON to `NOTIFY_WEBHOOK_URL` and takes an
   injectable `fetch` so it's unit-tested offline. A durable retry/outbox is out of scope.

7. **`approval` notification type is reserved but not triggered.** #8 lists "approval requests" as
   an activity, but no approval primitive is merged in the platform yet. The `approval` type exists
   in the model + transport so the surface is complete and forward-compatible, but **no in-repo
   code emits it** — it's wired when an approval primitive lands.

## Consequences
- Notifications are purely additive on #4/#5/#6/#9/#14: one additive migration
  (`0007_notifications`: the `notifications` + `notification_preferences` tables), one new
  `ServerEvent` variant, one new Redis key pattern, and the `/me/notifications[*]` +
  `/me/notification-preferences` endpoints. No existing contract changed; the full prior
  integration suite (channels, realtime, threads-mentions, tasks, RBAC, search) stays green.
- Agents are first-class recipients: an `@agent` mention or a task auto-routed to an agent lands
  as a durable notification on the agent's inbox *and* socket — the actionable hook later
  automation can poll (inbox) or react to live (WS).
- Because notification delivery reuses #6's workspace-scoped, subscription-independent member
  targeting, a member mentioned in a channel they can't read still gets the notification (the same
  property — and caveat — as #6). Tightening to channel-visible recipients is future hardening.
- Preferences gate at creation, so a member who later clears `muted` does **not** retroactively see
  notifications that were suppressed while muted — they were never written. This matches "mute =
  don't bother me," not "queue silently."
- `excerpt` is a point-in-time snapshot: editing the source message/task does not update existing
  notifications. Acceptable for an activity feed; re-derivation is out of scope.
- The notification row has no per-message dedupe: a message that both `@mentions` you and is a DM
  to you yields two notifications (distinct types). Demos/tests keep these activities separate; a
  collapse-by-source policy is future work if the inbox proves noisy.
</content>
