# Spec: Reload Platform — Threads + @mentions (human and agent) (Issue #6)

> Implements [#6](https://github.com/gagan114662/agent-skills/issues/6). Phase 1 — Core chat. Depends on #4 (messages), #5 (realtime), #9 (RBAC).
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Pre-approved by Gagan for end-to-end execution through PR (no merge without review + video).

## Objective
**What:** Threaded replies and `@mentions` on top of the #4 messages + #5 realtime stream.
A reply is a message whose `parent_message_id` points at a root message; a thread view returns
the root plus its replies in order, with a reply count. A message body is scanned for
`@handle` tokens on post; each token that resolves to a workspace **member** (human *or* agent)
becomes a persisted **mention** row and a realtime `mention` event delivered to that member's
sockets. Mentioning an **agent** is therefore an actionable signal the agent can act on the
instant it lands. Each member can read **their own mentions** and a **mention count**.

**Why:** #4 gave humans and agents a shared message store; #5 made it live. #6 makes
conversations *structured* (threads) and *addressable* (mentions) — the two reload.chat
primitives that turn a flat channel into a place where a specific human or agent gets pulled in.

**Who:** Humans (session cookie) and agents (Bearer token) — both are `members`; both post
replies, both can be mentioned, both receive `mention` events over the same #5 socket.

### Acceptance criteria (from #6)
- **Reply creates a thread; ordered replies returned** — posting with a `parentMessageId`
  (or via the reply endpoint) creates a reply; the thread view returns the root + replies
  in chronological order, with `replyCount`.
- **`@agent` / `@human` resolve + create records/events** — a body mentioning a member
  persists a mention row and emits a realtime `mention` event to that member.
- **Mention count surfaces for the mentioned member** — a member can read their mentions and
  their mention count.
- **Parser edge cases tested** — multiple mentions, unknown handles (no member → no record),
  and self-mention (author mentioning themselves → no record/notification).
- A reply and a mention both ride the **#5 WS gateway** (extend the `ServerEvent` union, no break).
- Everything stays **workspace-scoped** and respects **#9** channel capability: `write` to post
  a reply, `read` to view a thread.

### Out of scope (deferred)
- **Per-channel read state / true unread cursors** (#8 notifications) — #6 ships *mention*
  counts (how many times you were @'d), not a full last-read-per-channel unread model.
- **Rich mention syntax / autocomplete UI, group mentions** (`@channel`, `@here`) — #6 resolves
  single-token `@handle` against member display names; multi-word handles and group mentions
  are future work (a `handle` column would make multi-word robust).
- **Nested threads.** Threads are one level deep (Slack semantics): a reply to a reply attaches
  to the same root. The data model permits deeper nesting; the API flattens it.
- **Editing/deleting mentions on message edit** — mentions are extracted at post time; message
  edit (#future) re-extraction is out of scope.

## Threads
A reply is an ordinary `messages` row with `parent_message_id` set (the column exists since #2).
- **Post a reply:** `POST /channels/:cid/messages/:mid/replies` — body `{ body, alsoSendToChannel? }`.
  Requires `write` (#9). Validates `:mid` is a non-deleted message **in this channel**. Nesting is
  flattened: if `:mid` is itself a reply, the new reply attaches to its **root** so threads stay
  one level deep. Returns the created message (incl. `parentMessageId`, `alsoSentToChannel`).
  The existing `POST /channels/:cid/messages` keeps accepting an optional `parentMessageId`
  (same validation) so #4/#5 callers are unaffected.
- **Thread view:** `GET /channels/:cid/messages/:mid/thread` — requires `read` (#9). Returns
  `{ root, replies, replyCount }`, replies ordered by `created_at` ascending.
- **also-send-to-channel:** a reply may be flagged `alsoSendToChannel` (Slack's "also send to
  channel"). It is persisted on the message (`also_sent_to_channel`) and carried in REST + WS
  payloads so clients can surface the reply in the main timeline as well as the thread. The flat
  `GET /channels/:cid/messages` endpoint is **unchanged** (returns the channel's messages as
  before) — clients render threads from `parentMessageId` + `alsoSentToChannel`. (ADR-0006 §1.)
- **reply count:** the thread view computes `replyCount` (non-deleted children of the root).

## Mentions
**Parse → resolve → persist → notify**, executed inside the reply/post path after the message
is written (the message is the source of truth; mentions are derived).

- **Parse (pure):** `parseMentionTokens(body): string[]` extracts `@`-prefixed handles —
  `@` followed by `[A-Za-z0-9._-]+`, not preceded by a word char (so `email@host` is **not** a
  mention). Returns lowercased, de-duplicated tokens. Pure and unit-tested; never throws.
- **Resolve:** each token is matched case-insensitively against **workspace** members'
  `display_name`. Unknown tokens resolve to nothing (skipped). The **author is excluded**
  (self-mention creates no record/notification).
- **Persist:** one `message_mentions` row per resolved member (`UNIQUE(message_id,
  mentioned_member_id)` makes it idempotent). Rows carry `workspace_id` + `channel_id`
  (denormalized) so "my mentions" and counts are single-table, workspace-scoped reads.
- **Notify:** for each persisted mention, publish a `mention` event on the #5 stream to the
  **mentioned member's** sockets (human or agent). For agents this is the actionable hook.
- **Read:** `GET /me/mentions` → the caller's mentions (newest first, with message body +
  channel). `GET /me/mentions/count` → `{ count }`.

## Transport & protocol (extends #5, non-breaking)
`ServerEvent` gains one variant; `Message` gains `alsoSentToChannel`:
```jsonc
{ "type": "message", "message": { id, channelId, authorMemberId, parentMessageId, alsoSentToChannel, body } }
{ "type": "mention", "mention": { id, messageId, channelId, mentionedMemberId, authorMemberId, body } }
```
- A **reply** flows through the existing publish-on-write path (`publishMessageEvent`) so channel
  subscribers see it live — same `message` event, now carrying `parentMessageId`/`alsoSentToChannel`.
- A **mention** is delivered to the mentioned member regardless of channel subscription. New Redis
  key `rt:mention:{workspaceId}` carries `mention` events; the gateway keeps a per-member socket
  index (`byMember`) and forwards a `mention` only to the mentioned member's sockets in that
  workspace. No client command changes; clients just receive a new event type.

## Data model (additive migration `0003_threads_mentions`)
Next free number after `0002_rbac`. Up + paired down, both idempotent.
- `ALTER TABLE messages ADD COLUMN also_sent_to_channel boolean NOT NULL DEFAULT false;`
  (safe: default false → existing rows + roots unaffected.)
- ```sql
  CREATE TABLE message_mentions (
    id                   uuid PRIMARY KEY,
    workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_id           uuid NOT NULL REFERENCES channels(id)   ON DELETE CASCADE,
    message_id           uuid NOT NULL REFERENCES messages(id)   ON DELETE CASCADE,
    mentioned_member_id  uuid NOT NULL REFERENCES members(id)    ON DELETE CASCADE,
    author_member_id     uuid NOT NULL REFERENCES members(id)    ON DELETE CASCADE,
    created_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT message_mentions_uniq UNIQUE (message_id, mentioned_member_id)
  );
  CREATE INDEX message_mentions_member_idx ON message_mentions (mentioned_member_id, created_at);
  ```
- **down:** drop the table (+ index) and the column.

## Code layout
- `src/db/schema/messages.ts` — add `alsoSentToChannel`.
- `src/db/schema/mentions.ts` — new `messageMentions` table (exported from schema index).
- `src/messaging/mentions.ts` — pure `parseMentionTokens(body)` (no DB; unit-tested).
- `src/db/repositories/messages.ts` — `getMessage`, `getRootId`, `listThreadReplies`,
  `countReplies`, `alsoSentToChannel` on `postMessage`/`Message`.
- `src/db/repositories/mentions.ts` — `resolveAndPersistMentions` (resolve tokens →
  workspace members, exclude author, insert), `listMentionsForMember`, `countMentionsForMember`.
- `src/realtime/protocol.ts` — `Mention` type + `mention` variant on `ServerEvent`.
- `src/realtime/bus.ts` — `MENTION_KEY_PREFIX` / `MENTION_PATTERN`, `mentionKey`,
  `workspaceIdFromMentionKey`, `publishMention`.
- `src/realtime/gateway.ts` — `byMember` index (maintained in `onConnection`/`close`),
  `PSUBSCRIBE` the mention pattern, forward `mention` events to the target member's sockets.
- `src/routes/channels.ts` — reply endpoint, thread endpoint; extract mentions on post + reply.
- `src/routes/me.ts` — `GET /me/mentions`, `GET /me/mentions/count`.

## Testing strategy
- **Unit (`test/unit`, no Redis):** `parseMentionTokens` — single, multiple, dedupe, unknown-ish
  tokens, self token preserved by the parser (self-exclusion is the resolver's job), email not a
  mention, punctuation boundaries. Plus the protocol parser stays green.
- **Integration (real Postgres + Redis, `test/integration`):**
  1. **Threaded reply retrievable + broadcast:** member posts a root, opens WS + subscribes,
     posts a reply via the reply endpoint → receives a `message` event with `parentMessageId`
     set; `GET …/thread` returns the root + the reply in order with `replyCount = 1`.
  2. **@mention creates a record + notifies the member:** human mentions an **agent** by name;
     the agent connects WS → receives a `mention` event; `GET /me/mentions` (as the agent) shows
     the mention and `…/count` is ≥ 1. Self-mention and an unknown handle create no rows.
  3. **Access control:** a non-member / `read`-only member cannot post a reply (403); a
     non-member cannot read a thread (403). (Reuses the #9 `requireChannelCapability` seam.)
- Runs in the existing `integration` CI job (Postgres + Redis service containers).

## Quality gates (must pass before PR)
From `platform/`: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`, plus
`pnpm --filter @reload/server test:integration` against real Postgres + Redis.

## Boundaries
- **Always:** enforce #9 capability (`write` to reply, `read` to view a thread); scope mentions,
  threads, and the mention stream by `identity.workspaceId`; keep REST the source of truth
  (publish-on-write, best-effort); exclude the author from their own mentions; write the failing
  test first; attach a demo + ADR.
- **Ask first:** changing the flat `GET …/messages` contract; adding a `handle` column / mention
  autocomplete; introducing real per-channel unread cursors (that's #8); any new dependency.
- **Never:** deliver a `mention` event to anyone but the mentioned member; leak threads/mentions
  across workspaces or channel boundaries; let a non-member/`read`-only caller post a reply;
  require Redis for the REST/`inject` path or the no-Redis `quality` job; merge without approval + video.

## Success criteria
1. Reply endpoint creates a thread; `…/thread` returns root + ordered replies + `replyCount`
   (integration-tested) and the reply broadcasts as a #5 `message` event.
2. `@mention` of a human/agent persists a `message_mentions` row and pushes a `mention` event to
   that member; self + unknown handles persist nothing (integration- + unit-tested).
3. `GET /me/mentions` + `…/count` surface the caller's mentions, workspace-scoped.
4. `write`/`read` capability + workspace scoping enforced on reply/thread (integration-tested).
5. All quality gates green (typecheck, lint, unit, build) + integration green; **video**
   `platform/docs/demos/06-threads-mentions.mp4` + **ADR-0006**.

## Decisions (resolved — pre-approved for end-to-end execution)
1. **Flat list stays inclusive; threads are a view.** `GET /channels/:cid/messages` is unchanged
   for #4/#5 compatibility; the thread view is a new endpoint and `alsoSentToChannel` is persisted
   metadata clients use to render the channel/thread split. → ADR-0006.
2. **Threads one level deep.** Replies to replies re-parent to the root (Slack semantics); the
   schema allows deeper nesting but the API flattens it. → ADR-0006.
3. **Mentions derived at post time, persisted, then notified.** The message is the source of
   truth; mention rows + events are derived after the write and are best-effort on the realtime
   side (a Redis hiccup never fails the post). → ADR-0006.
4. **Member-targeted mention delivery via `rt:mention:{wid}` + a `byMember` socket index.**
   A `mention` reaches only the mentioned member's sockets, independent of channel subscription —
   so an @'d agent is notified even if it isn't watching the channel. → ADR-0006.
5. **Resolve by display name, single token, author excluded.** Good enough for #6 acceptance; a
   `handle` column for robust multi-word/ambiguous resolution is noted as future work. → ADR-0006.
