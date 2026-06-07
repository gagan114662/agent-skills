# ADR-0009: Agent registry & role-based permissions (read/write/propagate)

- **Status:** Accepted (defaults chosen — issue #9; security-critical, see review note)
- **Date:** 2026-06-06
- **Context issue:** [#9](https://github.com/gagan114662/agent-skills/issues/9)
- **Builds on:** [ADR-0003](0003-auth-identity.md) (identity), [ADR-0004](0004-channels-dms.md) (membership — the seam this layers onto)

## Context
#4 gated channel read/post on bare **membership**. ADR-0004 §2 named #9 as the seam that layers **roles** (`read`/`write`/`propagate`) onto that model — without ripping membership out. We also need the agent **registry** (list + deactivate) over the agents #3 already mints tokens for.

## Decisions
1. **Capability ladder, not a role table.** Three cumulative levels: `read` (1) < `write` (2) < `propagate` (3). The three capabilities *are* the roles for #9 — no separate named-role abstraction yet. `satisfies(have, needed)` is a rank comparison. `propagate` is the admin tier: the right to grant/extend roles to others.
2. **Roles layer on top of membership; they don't replace it.** Effective capability on a channel =
   - **not a channel member →** none (403) — membership is still the first gate (ADR-0004 §2 preserved);
   - **explicit `permissions` row →** that level (a `read` grant is a deliberate *downgrade*);
   - **member, no row →** `write` (the #4 default — every channel member could post; #4 tests stay green unchanged).
   So the default is unchanged behavior and roles *refine* it. This is the literal reading of "layer on, don't rip out."
3. **Channel-scoped grants for #9.** Grants always target a channel (`resource_type='channel'`, non-null `resource_id`). The channel **creator** is auto-granted `propagate` at creation, so every channel has an administrator. Workspace-wide/org roles are deferred (the schema can carry `resource_type='workspace'`, but #9 enforces only channel scope).
4. **Grant = upsert; revoke = delete; both immediate.** A `UNIQUE (workspace_id, member_id, resource_type, resource_id)` makes one effective level per member/resource and turns grant into an idempotent upsert. The capability is re-read from the DB on **every** request — no caching — so grant/revoke take effect on the very next call. Granting **auto-adds** the target to the channel (granting access implies presence).
5. **Workspace-scoped throughout (carry the #3 IDOR discipline).** Every grant checks the target `memberId` belongs to `identity.workspaceId` (`memberInWorkspace`) → cross-workspace role assignment is a 404. Every capability check is against `identity.workspaceId`. Grant/revoke require `propagate`; a `write`-only member cannot grant.
6. **A single access helper keeps routes thin.** `requireChannelCapability(identity, channelId, needed, reply)` is the one access call routes make: it loads the channel (404 on workspace mismatch), checks membership, computes effective capability, and asserts the rank. Pure, unit-tested ladder functions (`satisfies`, `effectiveCapability`) live beside it.
7. **Registry + deactivation.** `GET /workspaces/:wid/agents` lists profiles; `POST …/agents/:agentId/deactivate` (owner/human-only, workspace-scoped) sets `agents.deactivated_at` **and** revokes the agent's tokens. `resolveIdentity` rejects a deactivated agent (its member no longer resolves) → deactivation is immediate, mirroring #3's revocable-session principle.

## Enforcement map
| Endpoint | Capability |
|---|---|
| `GET /channels/:cid/messages`, `GET /channels/:cid/grants` | `read` |
| `POST /channels/:cid/messages`, `POST /channels/:cid/archive` | `write` |
| `POST /channels/:cid/grants`, `DELETE /channels/:cid/grants/:mid` | `propagate` |

Membership self-management (`POST/DELETE /channels/:cid/members`) is left exactly as #4 — capability administration is the new, `propagate`-gated surface.

## Consequences
- **Positive:** RBAC with zero behavior change for existing members; immediate grant/revoke; cross-tenant escalation closed; one helper, thin routes; additive `0002_rbac` migration with a clean down (CI down/up step green).
- **Costs / deferred:** **Tasks & memory** (`tasks`, `memories` stubs) have no routes yet — `requireCapability` is written generically so #14/#15 wire the same check in when they build real endpoints; #9 enforces only the live channel/message surface (per the issue's dependency on #4). Workspace/org roles, custom named roles, and realtime revocation push to open WebSocket sessions (#5) are out of scope.
- **Security posture:** RBAC enforcement and the privilege-escalation paths (grant requires `propagate`; cross-workspace rejected; deactivation immediate) are covered by the integration acceptance matrix. **Security-critical — wants a `security-and-hardening` review and stays exempt from auto-merge (Gagan approves on the video).**
