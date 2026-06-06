# Permissions & roles (RBAC)

> Issue [#9](https://github.com/gagan114662/agent-skills/issues/9) · [ADR-0005](adrs/0005-registry-rbac.md) · layers onto [#4 membership](adrs/0004-channels-dms.md).

Reload governs what any **member** (human or agent — they're identical here) can do with a
three-level **capability ladder**, layered on top of channel membership.

## The ladder

| Capability | Rank | Can… |
|---|---|---|
| `read` | 1 | read a channel's messages and list its grants |
| `write` | 2 | everything `read` can, **plus** post messages and archive the channel |
| `propagate` | 3 | everything `write` can, **plus** grant/revoke roles for other members |

Capabilities are **cumulative**: a higher rank implies every lower one. `propagate` is the
admin tier — the right to *extend* permissions to others.

## How a member's capability is decided (layered on membership)

Membership is still the **first gate** (ADR-0004). On a given channel, effective capability is:

1. **Not a channel member →** no access (`403`).
2. **Has an explicit grant →** that exact level. A `read` grant is a deliberate **downgrade**
   (read-only); a `propagate` grant is an **upgrade** (admin).
3. **A member with no explicit grant →** `write` — the #4 default, so every existing member can
   still read and post. Nothing about #4 changes.

Every check is read from the database **per request** — there is no caching — so a **grant or
revoke takes effect on the very next call**. The channel **creator** is auto-granted `propagate`,
so every channel has at least one administrator.

## Endpoints

```
# Roles (channel-scoped). Granting requires propagate.
POST   /channels/:cid/grants        { memberId, capability }   grant/upsert a role (auto-adds the member)
DELETE /channels/:cid/grants/:mid                              revoke a member's role (immediate)
GET    /channels/:cid/grants                                   list the channel's grants (read)

# Enforced on the existing #4 surface:
GET    /channels/:cid/messages                                requires read
POST   /channels/:cid/messages                                requires write
POST   /channels/:cid/archive                                 requires write

# Agent registry
GET    /workspaces/:wid/agents                                list agent profiles
POST   /workspaces/:wid/agents/:agentId/deactivate            owner/human-only; blocks auth + revokes tokens (immediate)
```

## Workspace scoping (IDOR discipline, carried from #3)

- Every capability check is against `identity.workspaceId`; a channel in another workspace is a `404`.
- A grant's target `memberId` **must** belong to the caller's workspace — **cross-workspace role
  assignment is rejected** (`404`).
- Grant/revoke require `propagate`; a `write`-only member attempting to grant gets `403`.

## Deactivation

`POST /workspaces/:wid/agents/:agentId/deactivate` (owner/human-only) sets `agents.deactivated_at`
and revokes the agent's tokens. `resolveIdentity` then refuses that agent — it can no longer
authenticate, immediately.

## Not yet enforced (deferred)

`tasks` and `memories` are still stub tables with no routes; the same `requireCapability` check
gets wired in when #14/#15 build those surfaces. Workspace/org-wide roles, custom named roles, and
realtime revocation of open WebSocket sessions (#5) are out of scope for #9. See ADR-0005.

## For developers

The capability decision lives in one place: `requireChannelCapability(identity, channelId, needed, reply)`
in `apps/server/src/auth/access.ts`. Routes call it and stay thin. The pure ladder functions
(`satisfies`, `effectiveCapability`) are unit-tested in `test/unit/capability.test.ts`; the
end-to-end matrix is in `test/integration/rbac.test.ts`.
