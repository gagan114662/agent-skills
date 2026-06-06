# Spec: Reload Platform — Channels & DMs (Issue #4)

> Implements [#4](https://github.com/gagan114662/agent-skills/issues/4). Phase 1 — Core chat. Depends on #1, #2, #3.
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). No code until approved.

## Objective
**What:** The HTTP/service layer for **channels** and **direct messages** on top of the #2 schema: create/list/archive channels, get-or-create DMs, join/leave membership, and **post/read messages over REST** — all gated by the #3 auth middleware and channel membership.

**Why:** This is the first real product surface — where humans and agents actually talk. It's the head of the messaging lane: #5 (realtime) layers WebSocket delivery on these same endpoints, #6 (threads/mentions) extends messages, #9 (RBAC) layers finer permissions on this membership model.

**Who:** Humans (session) and agents (Bearer token) — both are `members`, both use these endpoints identically.

### Acceptance criteria (from #4)
- Create a channel, add members, **post a message via REST, read it back**.
- A DM channel auto-resolves/creates for a given member set (no duplicates).
- Archived channels are hidden from the default list.
- Access is membership-scoped: a non-member can't read or post in a channel (tested).

### Out of scope (deferred)
- **Realtime delivery / presence** (#5) — #4 returns via REST only.
- **Threads & @mentions** (#6) — messages here are flat (the `parent_message_id` column exists but threading UX/semantics are #6).
- **Fine-grained RBAC** read/write/propagate (#9) — #4 uses simple membership-based access; #9 layers roles on top.
- **Search** (#7), **notifications** (#8).
- No new DB migration — `channels`, `channel_members`, `messages` already exist from #2.

## Endpoints (all require auth via #3 `resolveIdentity`)
```
POST   /workspaces/:wid/channels        { name }              create a public channel (caller auto-joins)
GET    /workspaces/:wid/channels                              list non-archived channels in the caller's workspace
POST   /channels/:cid/archive                                 archive a channel (member-only)
POST   /channels/:cid/members           { memberId }          add a member (or self-join a public channel)
DELETE /channels/:cid/members/:mid                            leave / remove a member
POST   /workspaces/:wid/dms             { memberIds: [...] }  get-or-create a DM for a member set
POST   /channels/:cid/messages          { body, parentMessageId? }   post a message (member-only)
GET    /channels/:cid/messages                               list messages chronologically (member-only)
```
All operations are workspace-scoped: the caller's `identity.workspaceId` must match the channel/target workspace (cross-tenant access → 403/404), consistent with the #3 IDOR fix.

## Service/repo layer
Extends the existing `repositories/channels.ts` + `messages.ts` (from #2) with: `listChannels`, `archiveChannel`, `removeChannelMember`, `getOrCreateDm`, `getChannel` (+ workspace guard). Routes are thin; access checks live in a small `requireChannelMember(identity, channelId)` helper.

## Testing strategy
- **Integration (real Postgres):** full acceptance flow — create channel → post message (REST) → read back; DM get-or-create idempotency (second call returns the same channel); archived channel hidden from list; **non-member gets 403 on read and post**; cross-workspace access blocked.
- Runs in the existing `integration` CI job. Hermetic unit tests for any pure helpers (e.g. the DM member-set key).

## Boundaries
- **Always:** authenticate every endpoint (#3); enforce channel membership for read/post; scope every query by workspace; write the failing integration test first; attach a demo video.
- **Ask first:** changing the access model before #9 lands; adding columns to #2 tables.
- **Never:** let a non-member read/post; cross-tenant access; merge without approval + video.

## Success criteria
1. Create channel → add member → POST message → GET messages returns it.
2. `POST /dms` twice with the same member set returns the **same** channel id.
3. Archived channel absent from `GET /channels`.
4. Non-member → 403 on that channel's messages; cross-workspace → 403/404 (tested).
5. Integration green in CI; **video** `platform/docs/demos/04-channels-dms.mp4` (create → post → read → DM dedupe → non-member blocked) + ADR-0004 if any non-obvious decision.

## Open Questions (need your input before PLAN)
1. **DM dedupe key.** Recommend: a DM is identified by its **exact sorted set of member ids**; `POST /dms` computes that key and returns the existing channel if one matches, else creates it. (Supports group DMs, not just 1:1.) OK?
2. **Public channel join policy.** Recommend **open join** — any workspace member may join/post in a `public` channel; `POST /channels/:cid/members` with no body = self-join. (Private/invite-only channels deferred.) OK?
3. **Access model for #4.** Recommend **membership-based** (must be a channel member to read/post; any workspace member can create + list public channels), with #9 layering read/write/propagate **roles** on top later. Agree this is the right seam?
4. **Archive semantics.** Recommend archived = hidden from default list + **read-only** (no new posts), not deleted. OK?

Reply with approval (+ overrides), or **"use defaults and go"** → PLAN → BUILD (TDD) → video → PR (I won't merge without your approval).
