# Spec: Reload Platform — Linear-style Task System (Issue #14)

> Implements [#14](https://github.com/gagan114662/agent-skills/issues/14). Phase 3 — Coordination. Depends on #2 (data model — the `tasks` stub), #3 (auth/identity), #9 (RBAC helper pattern / IDOR discipline).
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Builds on [ADR-0002](../adrs/0002-data-model.md), [ADR-0003](../adrs/0003-auth-identity.md), [ADR-0009](../adrs/0009-registry-rbac.md). No code until approved → PLAN → BUILD (TDD) → demo → PR (no merge without approval).

## Objective
**What:** A Linear-style task system where humans **and** agents create, assign, hand off, and progress work. Tasks carry a status lifecycle (`backlog → … → done`), a single assignee (human or agent member), free-form labels, and links to other platform objects (messages, memories). Every state change is recorded as an immutable **event**, so assignment/status history survives reassignment. Rule-based **auto-routing** assigns a task to a capable agent (label → eligible agents) and load-balances across them (round-robin / least-loaded). Two read views: a **board** (grouped by status) and **by-assignee**.

**Why:** Phase 3 is coordination. Messaging (#4/#5) lets members talk; tasks let them *divide and track work*. Agents become first-class workers: a human (or another agent) files a task, auto-routing hands it to the right agent, the agent marches it through the lifecycle, and the whole chain is auditable. This is the substrate later phases (memory #15, MCP surface) build on.

**Who:** Humans (session cookie) and agents (Bearer token) — both are `members` (#3), and both are interchangeable as task creators *and* assignees (ADR-0002 §5). Auto-routing targets agent members specifically (it routes work *to* automation).

## The model

### Status lifecycle
Six statuses with validated transitions (a pure, unit-tested function — no free-for-all updates):

```
backlog ─┬─→ todo ─┬─→ in_progress ─┬─→ done
         │         │     ↑    │  ↑   │
         │         ↓     │    ↓  │   │
         └───→ canceled  └─ blocked ─┘
                  ↑              ↑
        (any non-terminal) ──────┘
done / canceled ──→ todo            (reopen)
```

Allowed transitions (`canTransition(from, to)`):
| from | allowed `to` |
|---|---|
| `backlog` | `todo`, `in_progress`, `canceled` |
| `todo` | `in_progress`, `backlog`, `canceled` |
| `in_progress` | `blocked`, `done`, `todo`, `canceled` |
| `blocked` | `in_progress`, `canceled` |
| `done` | `todo` (reopen) |
| `canceled` | `todo` (reopen) |

`done` and `canceled` are terminal except for an explicit reopen to `todo`. A no-op transition (same → same) is rejected (`409`). An invalid transition is rejected (`409`) and records no event. New tasks default to `backlog` (the #2 stub default, unchanged).

### Assignment & events
A task has **one** `assignee_member_id` (nullable). Assigning, reassigning, and unassigning all append an immutable row to **`task_events`** — the audit log. Event types: `created`, `status_changed`, `assigned`, `reassigned`, `unassigned`, `linked`, `unlinked`. Each event carries the actor, a `from`/`to` value, and a `detail` JSON blob. **Assignment history = the ordered `assigned`/`reassigned`/`unassigned` events**, so reassigning never loses the chain. Events are append-only; nothing mutates or deletes them.

### Links (resolve both ways)
A task links to other workspace objects via a polymorphic **`task_links`** row `(target_type, target_id)`. This issue supports `message` and `memory` targets (both tables exist; both are workspace-validated on create to close IDOR). The link resolves **both ways**:
- forward: `GET /tasks/:tid/links` → the objects a task references;
- reverse: `GET /workspaces/:wid/links/:type/:targetId/tasks` → the tasks that reference a given object.

`file` targets are deferred until a files subsystem exists (no table to workspace-validate against); the schema is already polymorphic, so files slot in without migration churn. Documented in the ADR.

### Auto-routing (capability/role + round-robin)
A **`task_routing_rules`** row maps a `label` → an eligible `agent_member_id`. The label *is* the capability/role (e.g. label `triage` → agents that can triage). To auto-route a task:
1. gather the task's labels;
2. collect the **eligible** agent members = union of rule targets whose `label` ∈ the task's labels, restricted to agents that are **active** (not deactivated, #9) and in the workspace;
3. among eligible agents, pick the **least-loaded** (fewest open = non-terminal tasks), tie-broken deterministically by member id — i.e. round-robin by load;
4. if no rule matches, the task stays unassigned (auto-route is a best-effort assist, never an error).

The selection step is a pure, unit-tested function; the data-gathering step is the repository. A rule targeting a single agent is just an eligible set of one — so "route to a specific capable agent" and "round-robin across capable agents" are the same mechanism.

### Access model (workspace-scoped; carry #3/#9 IDOR discipline)
Tasks are a **workspace-level** resource (not channel-scoped like #9's grants). Access = **workspace membership**: any member of the caller's workspace may read and manage that workspace's tasks. Every workspace-addressed route asserts `identity.workspaceId === :wid` (`assertWorkspace`, 403 on mismatch). Every task-id-addressed route loads the task and 404s if its `workspace_id` ≠ the caller's — a single helper `requireTaskInWorkspace(identity, taskId, reply)` keeps routes thin and makes cross-tenant access impossible to forget. Routing-rule and link targets are workspace-validated too: you can never route to, or link, a member/object from another workspace.

Finer-grained per-task RBAC (e.g. only the assignee may close) is deferred — #9's `permissions` ladder is channel-scoped and tasks reuse the same *pattern* (one access helper, re-read per request) without inheriting channel grants.

## Endpoints (all require auth via #3 `resolveIdentity`, all workspace-scoped)
```
POST   /workspaces/:wid/tasks                    create {title, description?, labels?, assigneeMemberId?, autoRoute?}
GET    /workspaces/:wid/tasks                     list (?status= &assignee=) — by-assignee view via ?assignee=
GET    /workspaces/:wid/tasks/board               board view: { [status]: Task[] }
GET    /tasks/:tid                                get one task
PATCH  /tasks/:tid/status        { status }       validated transition (+status_changed event); 409 if invalid
POST   /tasks/:tid/assign        { assigneeMemberId? | autoRoute? }   assign/reassign/unassign or auto-route (+event)
GET    /tasks/:tid/events                         full event/assignment history (chronological)
POST   /tasks/:tid/links         { targetType, targetId }   link to a message/memory (+linked event); workspace-validated
DELETE /tasks/:tid/links/:type/:targetId          unlink (+unlinked event)
GET    /tasks/:tid/links                          forward: objects this task references
GET    /workspaces/:wid/links/:type/:targetId/tasks   reverse: tasks referencing a given object
POST   /workspaces/:wid/task-routing-rules   { label, agentMemberId }   create rule (agent must be in workspace)
GET    /workspaces/:wid/task-routing-rules        list rules
DELETE /workspaces/:wid/task-routing-rules/:ruleId   delete rule
```
`create` resolves the assignee in this precedence: explicit `assigneeMemberId` (validated in-workspace) → else `autoRoute:true` runs the router → else unassigned. `assign` mirrors it: `assigneeMemberId:null` unassigns, a value reassigns, `autoRoute:true` runs the router. Cross-workspace `assigneeMemberId`/`agentMemberId`/link target → `404`.

## Schema & migration (0003_tasks, additive — paired up/down)
The `tasks` stub (id, workspace_id, title, status default `backlog`, assignee_member_id, created_by_member_id, created_at) exists from #2 (`0000_init`). `0003_tasks.sql` adds:
- `tasks.description text` (nullable), `tasks.labels jsonb NOT NULL DEFAULT '[]'::jsonb`, `tasks.updated_at timestamptz NOT NULL DEFAULT now()`.
- `CHECK (status IN ('backlog','todo','in_progress','blocked','done','canceled'))` — the lifecycle is enforced at the DB edge too.
- `INDEX tasks (workspace_id, status)` (board) and `INDEX tasks (workspace_id, assignee_member_id)` (by-assignee / load lookups).
- `task_events` (id, workspace_id FK, task_id FK cascade, type, actor_member_id FK set null, from_value, to_value, detail jsonb default `'{}'`, created_at) + `INDEX (task_id, created_at)`.
- `task_links` (id, workspace_id FK, task_id FK cascade, target_type, target_id uuid, created_by_member_id FK set null, created_at) + `UNIQUE (task_id, target_type, target_id)` (idempotent link) + `INDEX (workspace_id, target_type, target_id)` (reverse lookup).
- `task_routing_rules` (id, workspace_id FK, label, agent_member_id FK members cascade, created_by_member_id FK set null, created_at) + `UNIQUE (workspace_id, label, agent_member_id)` + `INDEX (workspace_id, label)`.

The Drizzle schema moves `tasks` from `schema/stubs.ts` into its own `schema/tasks.ts` (with the new tables); `memories`, `memory_edges`, `permissions` stay in `stubs.ts`. `0003_tasks.down.sql` drops the three new tables and the three added columns/CHECK/indexes — CI's "prove down/up clean" step must stay green.

## Service/repo layer (routes stay thin)
- `src/tasks/status.ts` — `STATUSES`, `canTransition(from, to)` (pure, unit-tested).
- `src/tasks/routing.ts` — `selectLeastLoaded(candidates)` pure selection (least open-task count, tie-break by member id; unit-tested).
- `db/repositories/tasks.ts` — `createTask`, `getTask`, `listTasks(filters)`, `boardView`, `updateStatus`, `assignTask` (writes the right event by old/new), `listTaskEvents`, `addTaskLink`, `removeTaskLink`, `listTaskLinks`, `listTasksLinkingTo`, `createRoutingRule`, `listRoutingRules`, `deleteRoutingRule`, `pickRouteAssignee(workspaceId, labels)`. Status/assign/link mutations write their event in the **same transaction**.
- `db/repositories/memories.ts` — minimal shim for link validation/tests: `createMemory`, `memoryInWorkspace` (the full memory graph is #15).
- `db/repositories/messages.ts` — add `messageInWorkspace(id, wid)`.
- `auth/access.ts` — `requireTaskInWorkspace(identity, taskId, reply)`: loads the task, 404s on missing/cross-workspace, returns it or `undefined` after replying. The single access call task-id routes make.

## Testing strategy
- **Unit (hermetic):** `canTransition` matrix (valid / invalid / same-status / reopen); `selectLeastLoaded` (picks min load, deterministic tie-break, empty → null).
- **Integration (real Postgres), the #14 acceptance matrix:**
  1. **Create → assign agent → agent transitions status:** human creates a task, assigns an agent; the agent (Bearer) PATCHes status `todo → in_progress → done`; the read reflects it immediately and events record the chain.
  2. **Reassignment preserves history:** assign A, reassign to B; `GET …/events` shows `assigned`(A) then `reassigned`(A→B) — the full chain survives.
  3. **Auto-routing assigns a matching agent:** two agents eligible for label `triage`, one already loaded; auto-route picks the **least-loaded** eligible agent. A label with no rule → stays unassigned.
  4. **Links resolve both ways:** link a task to a message and a memory; `GET …/links` lists them; the reverse endpoint returns the task for that message/memory id.
  5. **Cross-workspace rejected:** a member of workspace B cannot create in A's `:wid` (403), cannot GET A's task by id (404), cannot be assigned A's task / be a routing target (404).
- Reuses the existing `integration` CI job (migrate → test → prove down/up clean). All prior suites (`channels`, `rbac`, …) stay green unchanged.

## Boundaries
- **Always:** authenticate every endpoint (#3); scope every query, assignee, routing target, and link target by `identity.workspaceId`; validate status transitions through the pure function; write events in the same transaction as the mutation; write the failing test first; keep routes thin (logic in helper/repo); attach a demo video.
- **Ask first:** per-task RBAC beyond workspace membership; realtime WebSocket push of task events (#5 surface); adding `file` link targets before a files table exists; new status values.
- **Never:** allow an invalid/no-op status transition; mutate or delete a `task_event` (audit is append-only); assign/route/link across workspaces; let a routing rule target a non-agent or deactivated agent; cache the access decision (re-read per request).

## Success criteria
1. Acceptance matrix (1–5) green in the `integration` job against real Postgres.
2. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass from `platform/`.
3. `0003_tasks` applies and reverses cleanly (CI down/up step green); all prior tests unchanged and green.
4. `requireTaskInWorkspace` is the single access call task-id routes make; auto-routing selection is a pure unit-tested function; no access/transition logic inlined in routes.
5. ADR-0014 records the lifecycle + event-sourced history + auto-routing decisions; `docs/tasks.md` documents the model; demo `docs/demos/14-tasks.mp4` walks the acceptance matrix.

## Open questions (defaults chosen; override before BUILD if any are wrong)
1. **Six-status lifecycle** (`backlog/todo/in_progress/blocked/done/canceled`) with validated transitions + reopen. OK, or a different status set?
2. **Event-sourced history** (immutable `task_events`) as the assignment/status audit, rather than a mutable `updated_by` column. OK?
3. **Auto-routing = label→eligible-agents rules + least-loaded round-robin**, targeting active agents only, no-match → unassigned (never an error). OK?
4. **Workspace-membership access** for tasks (no per-task RBAC this issue), reusing #9's single-helper pattern. OK?
5. **Links support `message` + `memory` now; `file` deferred** until a files table exists. OK?

Reply with approval (+ overrides), or **"use defaults and go"** → BUILD (TDD) → demo → PR (no merge without your approval).
