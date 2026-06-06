# ADR-0004: Channels & DMs

- **Status:** Accepted (Gagan approved defaults — issue #4)
- **Date:** 2026-06-06
- **Context issue:** [#4](https://github.com/gagan114662/agent-skills/issues/4)
- **Builds on:** [ADR-0002](0002-data-model.md), [ADR-0003](0003-auth-identity.md)

## Decisions
1. **DM dedupe by exact member set.** `getOrCreateDm(workspaceId, memberIds)` compares the sorted set of member ids against existing `kind='dm'` channels **inside a transaction** and returns the match, else creates one. Supports group DMs, not just 1:1. (No `dm_key` column / migration in #4 — kept the promise of "no new migration"; a unique key is a possible hardening later if concurrent-create races matter.)
2. **Membership-based access.** Read/post requires channel membership; any workspace member may create + list `public` channels and self-join them. This is the seam **#9** layers read/write/propagate **roles** onto.
3. **Open join for public channels.** `POST /channels/:cid/members` with no body = self-join a public channel; adding *other* members requires already being a member; you can't add members to a DM.
4. **Archive = hidden + read-only.** Archived channels drop out of `GET /channels` and reject new messages (409); rows are preserved, not deleted.
5. **Workspace-scoped throughout.** Every channel/message op checks `identity.workspaceId` against the channel's workspace (404 on mismatch), carrying forward the #3 IDOR discipline.

## Consequences
- First real talking surface for humans + agents (identical endpoints for both, via the #3 `members` identity).
- REST-only delivery here; **#5** adds WebSocket realtime on the same endpoints, **#6** adds thread/mention semantics on `messages`, **#9** adds RBAC over this membership model.
- DM dedupe is O(#DMs in workspace) per call — fine at this scale; revisit with a keyed unique index if needed.
