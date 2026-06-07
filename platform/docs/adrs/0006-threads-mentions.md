# ADR-0006: Threads + @mentions (human and agent)

- **Status:** Accepted (Gagan pre-approved end-to-end execution — issue #6)
- **Date:** 2026-06-06
- **Context issue:** [#6](https://github.com/gagan114662/agent-skills/issues/6)
- **Builds on:** [ADR-0004](0004-channels-dms.md), [ADR-0005](0005-realtime-messaging.md), [ADR-0009](0009-registry-rbac.md)

## Context
#4 gave humans and agents a shared message store (with a `parent_message_id` already on
`messages`); #5 made delivery live over a WebSocket gateway with Redis fan-out; #9 layered
read/write/propagate capability onto channel membership. #6 adds the two reload.chat primitives
that turn a flat channel into a place where a *specific* participant gets pulled in: **threaded
replies** and **@mentions** for humans and agents. Both must ride the existing #5 event stream
without breaking it, stay workspace-scoped, and respect #9 capability.

## Decisions

1. **The flat message list stays inclusive; threads are a *view*, not a re-shaping.**
   `GET /channels/:cid/messages` is unchanged (returns the channel's non-deleted messages, flat)
   so every #4/#5 caller is unaffected. Threading is additive: a new
   `GET /channels/:cid/messages/:mid/thread` returns `{ root, replies, replyCount }` with replies
   ordered by `created_at`. A reply may carry `also_sent_to_channel` (Slack's "also send to
   channel"); it is persisted metadata returned in REST + realtime payloads that clients use to
   render the channel/thread split, rather than the server forking the timeline. This keeps the
   server contract stable and pushes presentation policy to the client.

2. **Threads are one level deep.** A reply always attaches to the thread **root**: posting a
   reply to a reply re-parents it to the root (`resolveThreadRoot`). The schema permits arbitrary
   nesting (self-referencing FK), but the API flattens it — matching Slack/reload.chat and keeping
   the thread view a single `WHERE parent_message_id = root` query. Replies are posted via a
   dedicated `POST /channels/:cid/messages/:mid/replies`; the existing
   `POST /channels/:cid/messages` keeps accepting an optional `parentMessageId` (same validation).

3. **Mentions are derived at post time, persisted, then notified — best-effort.** The message is
   the source of truth. After the message is written, the body is parsed for `@handle` tokens,
   resolved to workspace members, and one `message_mentions` row is inserted per resolved member
   (`UNIQUE(message_id, mentioned_member_id)` makes it idempotent). A realtime `mention` event is
   then published. Persistence and notification are wrapped so a Redis/DB hiccup is logged but
   **never fails the REST write** — the same publish-on-write discipline as #5 message broadcast.

4. **Member-targeted mention delivery via `rt:mention:{workspaceId}` + a `byMember` socket index.**
   A `mention` event is delivered only to the **mentioned member's** sockets, independent of
   channel subscription, so an @'d agent is notified the instant it lands even if it isn't
   watching the channel — this is the *actionable agent event* the issue calls for. The gateway
   keeps a per-member routing table (`byMember`, keyed `${workspaceId}:${memberId}`), `PSUBSCRIBE`s
   `rt:mention:*` alongside the channel/presence patterns, and forwards a mention only to the
   target member. The `ServerEvent` union gains one `{type:"mention", mention}` variant and
   `Message` gains `alsoSentToChannel` — both additive, no breaking change to #5 clients.

5. **Resolve by display name, single token, author excluded.** A handle is `@` + `[A-Za-z0-9._-]+`
   not preceded by a word char (so `user@host` is not a mention); tokens are lowercased and
   de-duplicated and matched case-insensitively against members' `display_name` in the workspace.
   Unknown handles resolve to nothing; the **author is excluded** so a self-mention creates no
   record/notification. The parser is pure and unit-tested; resolution/persistence live in the
   mentions repository. Multi-word/ambiguous handles (a dedicated `handle` column) are deferred.

6. **#9 capability + workspace scope are enforced on the new seams.** Posting a reply requires
   `write`; viewing a thread requires `read` — both through the existing `requireChannelCapability`
   (so a non-member 404/403s and a `read`-only member can view but not reply). Mentions, threads,
   and the mention stream are all scoped by `identity.workspaceId`.

## Consequences
- Threads and mentions are purely additive on #4/#5/#9: one additive migration
  (`0003_threads_mentions`: `messages.also_sent_to_channel` + the `message_mentions` table), one
  new `ServerEvent` variant, one new Redis key pattern, and three new endpoints
  (`…/replies`, `…/thread`, `/me/mentions[/count]`). No existing contract changed.
- Agents become first-class addressable participants: an `@agent` mention lands as a realtime
  event on the agent's socket regardless of what it's subscribed to — the hook later automation
  (#8 notifications, task creation) can build on.
- "Mentions" here are *@-mention counts*, not a full per-channel read/unread cursor; true unread
  tracking is #8. The `message_mentions` table (with `created_at` + member index) is the seam #8
  will extend.
- Mention resolution is best-effort and at-post-time only: editing a message does not re-extract
  mentions, and a member renamed after a mention keeps the original row. Acceptable for #6; a
  `handle` column and edit-time re-extraction are noted as future work.
- Because a mention is delivered independent of channel subscription, a member who is mentioned in
  a channel they cannot read still receives the event (resolution is workspace-scoped). The
  message body in the event is the same body the author posted; tightening mention resolution to
  channel-visible members is a future hardening if needed.
