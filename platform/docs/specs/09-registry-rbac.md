# Spec: Reload Platform — Agent Registry & Role-Based Permissions (Issue #9)

> Implements [#9](https://github.com/gagan114662/agent-skills/issues/9). Phase 2 — Agent integration. Depends on #3 (auth/identity), #4 (channels/membership).
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Builds on [ADR-0003](../adrs/0003-auth-identity.md) and [ADR-0004](../adrs/0004-channels-dms.md). No code until approved.

## Objective
**What:** An agent/member **registry** (list + deactivate the agents already registered in #3) and a **role-based permission** layer with three capability levels — `read` / `write` / `propagate` — enforced on the existing channel + message endpoints. `propagate` is the right to grant/extend permissions to other members.

**Why:** #4 gated read/post on bare **channel membership**. ADR-0004 §2 explicitly names #9 as the seam that *layers roles onto that membership model*. This is the access-control spine the rest of phase 2 rides on: agents become first-class, governable participants whose abilities an owner can grant and revoke.

**Who:** Humans (session cookie) and agents (Bearer token) — both are `members` (#3). Roles apply uniformly to both; an agent with `read` is exactly as constrained as a human with `read`.

### The model (layered, not a rewrite)
`read` ⊂ `write` ⊂ `propagate` — an ordered ladder (ranks 1/2/3). A member's **effective capability** on a channel is:

1. their explicit `permissions` row for that channel, if one exists; **else**
2. `write` if they are a channel member (preserves #4 — every member could post); **else**
3. nothing (not a member → 403, exactly as #4).

So roles **layer on top of** membership: membership is still required first, then capability gates the specific action. A `read`-only row is an explicit *downgrade* below the member default. Revocation deletes the row → the member falls back to the membership default (or, if removed from the channel, to no access). Every check is re-read from the DB per request, so **grants/revokes take effect immediately** (no caching).

| Action | Endpoint | Capability required |
|---|---|---|
| read messages / list grants | `GET /channels/:cid/messages` | `read` |
| post a message | `POST /channels/:cid/messages` | `write` |
| archive a channel | `POST /channels/:cid/archive` | `write` |
| grant/revoke a role to another member | `POST/DELETE /channels/:cid/grants` | `propagate` |

The channel **creator** receives an explicit `propagate` grant at creation, so every channel has at least one administrator.

### Acceptance criteria (from #9)
- A `read`-only member can read a channel but **cannot post** (403).
- A `write` member can post.
- A `propagate` member can grant a role to another member; a `write`-only member **cannot** (403).
- A grant **revoked** stops working on the very next request (immediate effect).
- Cross-workspace role assignment is **rejected** (carry the #3 IDOR discipline).
- Registry: list a workspace's agents; **deactivate** an agent so it can no longer authenticate (immediate).
- `platform/docs/permissions.md` documents the model.

### In scope
- Registry: `GET /workspaces/:wid/agents` (list profiles), `POST /workspaces/:wid/agents/:agentId/deactivate` (owner-only; revokes tokens + blocks auth). Register/mint token already exist (#3).
- `permissions` capability ladder (`read`/`write`/`propagate`), channel-scoped, workspace-tenanted.
- A single `requireChannelCapability(identity, channelId, needed)` helper the routes call — routes stay thin.
- Grant/revoke endpoints, gated behind `propagate`, workspace-scoped.
- Enforcement wired into the existing channel + message endpoints.

### Out of scope (deferred)
- **Workspace-wide / org roles.** The `permissions` schema can carry `resource_type='workspace'`, but #9 only *enforces* channel-scoped grants. (Agent registry deactivation stays owner/human-gated as in #3.)
- **Tasks & memory enforcement.** Those surfaces are still stub tables (`tasks`, `memories` — no routes yet); `requireCapability` is written generically so #14/#15 wire the same helper in when they build real endpoints. Noted in the ADR, not built here.
- **Custom named roles / role templates.** The three capabilities *are* the roles for #9.
- **Realtime propagation** of revocation to open WebSocket sessions (#5).

## Endpoints (all require auth via #3 `resolveIdentity`, all workspace-scoped)
```
GET    /workspaces/:wid/agents                          list agents in the caller's workspace (registry)
POST   /workspaces/:wid/agents/:agentId/deactivate      owner/human-only: revoke tokens + block the agent (immediate)
POST   /channels/:cid/grants     { memberId, capability }   propagate-only: grant a role (auto-adds the member); upsert
DELETE /channels/:cid/grants/:memberId                  propagate-only: revoke a member's explicit grant (immediate)
GET    /channels/:cid/grants                             read-only: list the channel's explicit grants
```
Plus enforcement layered onto the **existing** #4 endpoints (`GET/POST /channels/:cid/messages`, `POST /channels/:cid/archive`). Their request/response shapes are unchanged; only the access decision tightens from "is a member" to "is a member with the required capability."

`grants` rejects any `memberId` whose `workspace_id` ≠ `identity.workspaceId` (404/403) — a member from another workspace can never be granted a role here.

## Schema & migration (0002_rbac, additive — paired up/down)
The `permissions` stub (id, workspace_id, member_id, resource_type, resource_id, capability + capability CHECK) already exists from #2. `0002_rbac.sql` adds:
- `granted_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL` — audit of who granted.
- `created_at timestamptz NOT NULL DEFAULT now()`.
- `UNIQUE (workspace_id, member_id, resource_type, resource_id)` — one effective level per member/resource; enables idempotent grant **upsert**. Grants always carry a non-null `resource_id` (the channel id), so NULL-distinctness doesn't bite.
- `INDEX permissions (member_id)` for per-member lookup.
- `agents.deactivated_at timestamptz` — deactivation flag; `resolveIdentity` rejects an agent whose `deactivated_at IS NOT NULL`.

`0002_rbac.down.sql` reverses all of the above. CI's "prove down/up clean" step must stay green.

## Service/repo layer (routes stay thin)
- `db/repositories/permissions.ts`: `getCapability`, `grantCapability` (upsert), `revokeCapability`, `listChannelGrants`.
- `db/repositories/agents.ts` (or extend auth repo): `listAgents`, `deactivateAgent` (sets `deactivated_at` + revokes tokens), workspace-scoped.
- `auth/access.ts`: `requireChannelCapability(identity, channelId, needed, reply)` — loads the channel (404 on workspace mismatch), asserts membership (403), computes effective capability, asserts rank ≥ needed (403). Returns the channel or `undefined` after replying. The capability ladder + `effectiveCapability` live here as pure, unit-testable functions.
- `auth/middleware.ts`: `resolveIdentity` additionally rejects deactivated agents.

## Testing strategy
- **Unit (hermetic):** the capability ladder — rank ordering, `effectiveCapability` (explicit row wins; member→`write` default; non-member→none); grant payload validation.
- **Integration (real Postgres), the #9 acceptance matrix:**
  1. `read`-only member: `GET` messages → 200; `POST` message → **403**.
  2. `write` member: `POST` message → 201.
  3. `propagate` member grants a role to another member → 201/200; a `write`-only member attempting the same grant → **403**.
  4. **Revocation is immediate:** grant `write` → post succeeds; revoke → next post **403**.
  5. **Cross-workspace:** granting a role to a member from another workspace → **403/404**.
  6. Registry: list agents returns registered agents; **deactivate** → that agent's token is rejected (401) on the next call.
- Reuses the existing `integration` CI job (migrate → test → prove down/up clean). Backward-compat: the #4 `channels.test.ts` must stay green unchanged.

## Boundaries
- **Always:** authenticate every endpoint (#3); check membership *then* capability; scope every query + every grant target by `identity.workspaceId`; write the failing test first; keep routes thin (logic in the helper/repo); attach a demo video.
- **Ask first:** introducing workspace-wide/org roles; enforcing on tasks/memory before those surfaces exist; changing #4 request/response shapes.
- **Never:** let a `read`-only member post; let a non-`propagate` member grant; grant across workspaces; cache the capability decision (must be immediate); rip out membership-based access (layer on it).

## Success criteria
1. Acceptance matrix (1–6 above) green in the `integration` job against real Postgres.
2. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass from `platform/`.
3. `0002_rbac` applies and reverses cleanly (CI down/up step green); #4 tests unchanged and green.
4. `requireChannelCapability` is the single access call the routes make; no access logic inlined in routes.
5. ADR-0009 records the ladder + layering decision; `platform/docs/permissions.md` documents the model; demo `platform/docs/demos/09-registry-rbac.mp4` walks the acceptance matrix.

## Open questions (defaults chosen; override before PLAN if any are wrong)
1. **Capability model = ordered ladder** (`read`<`write`<`propagate`), effective = explicit-row-else-member-default-`write`. Keeps #4 behavior intact, supports read-only downgrade, makes `propagate` the admin tier. OK?
2. **Channel-scoped grants for #9** (workspace-wide roles deferred), with the channel creator auto-granted `propagate`. OK?
3. **Grant auto-adds the target to the channel** (granting access implies presence). OK?
4. **Deactivation** = block auth + revoke tokens, owner/human-only (consistent with #3 agent endpoints). OK?

Reply with approval (+ overrides), or **"use defaults and go"** → PLAN → BUILD (TDD) → demo → PR (no merge without your approval).
