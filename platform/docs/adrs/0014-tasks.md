# ADR-0014: Linear-style task system — lifecycle, event-sourced history, auto-routing

- **Status:** Accepted (defaults chosen — issue #14)
- **Date:** 2026-06-06
- **Context issue:** [#14](https://github.com/gagan114662/agent-skills/issues/14)
- **Builds on:** [ADR-0002](0002-data-model.md) (the `tasks` stub + member model), [ADR-0003](0003-auth-identity.md) (identity), [ADR-0009](0009-registry-rbac.md) (the single-access-helper / IDOR pattern)

## Context
Phase 3 is coordination. #4/#5 gave members a place to talk; #14 gives them a way to **divide and track work**. The #2 data model already shipped a `tasks` stub (id, workspace_id, title, status default `backlog`, assignee_member_id, created_by_member_id) precisely so this issue could grow it additively. Humans and agents are interchangeable `members` (ADR-0002 §5), so both can create *and* be assigned work — and auto-routing exists to hand work to the right agent without a human in the loop.

## Decisions
1. **Six-status lifecycle with validated transitions, not free-form status writes.** `backlog → todo → in_progress → {blocked,done}`, plus `canceled`, plus an explicit reopen of a terminal task to `todo`. `canTransition(from, to)` is a pure, unit-tested function and a matching `CHECK` constraint guards the DB edge. A no-op (same → same) and any unlisted hop are `409`. This keeps the board meaningful (you can't jump `backlog → done`) while staying permissive enough for real workflows (block/unblock, reopen).
2. **Event-sourced history (`task_events`), not a mutable audit column.** Every create / status change / (re|un)assign / (un)link appends an **immutable** row carrying actor, `from`/`to`, and a `detail` blob. **Assignment history is *derived*** from the `assigned`/`reassigned`/`unassigned` events, so reassignment never overwrites the chain — the literal reading of "reassignment preserves history". Events are written in the **same transaction** as the mutation, so the log can never drift from state.
3. **Auto-routing = label→eligible-agent rules + least-loaded round-robin.** A `task_routing_rules` row maps a `label` → an eligible `agent_member_id`; **the label is the capability/role**. To route a task we take the union of rule targets whose label ∈ the task's labels (restricted to **active** agents, #9 deactivation respected), then pick the **least-loaded** by open (non-terminal) task count, tie-broken deterministically by member id. A rule targeting one agent is just an eligible set of one — so "route to a specific capable agent" and "round-robin across capable agents" are the *same* mechanism. No match → the task stays **unassigned**; auto-route is a best-effort assist, **never an error**. The selection step is a pure unit-tested function (`selectLeastLoaded`); the repository gathers eligibility + load.
4. **Polymorphic links that resolve both ways; `message` + `memory` now, `file` later.** `task_links (target_type, target_id)` is polymorphic with a `UNIQUE (task_id, target_type, target_id)` (idempotent link) and a reverse index `(workspace_id, target_type, target_id)`. Forward = "objects this task references"; reverse = "tasks referencing this object". This issue validates `message` and `memory` targets in-workspace (both tables exist); `file` is deferred until a files table exists to validate against — the schema already carries it, so files slot in with no migration churn.
5. **Workspace-membership access, reusing #9's single-helper pattern (no per-task RBAC yet).** Tasks are a **workspace-level** resource: any member of the caller's workspace may read/manage that workspace's tasks. `requireTaskInWorkspace(identity, taskId, reply)` is the one access call task-id routes make — it 404s a task in another workspace, carrying the #3 IDOR discipline. #9's `permissions` ladder is channel-scoped and is intentionally *not* inherited here; finer per-task RBAC (e.g. only the assignee may close) is deferred. Assignees, routing targets, and link targets are all workspace-validated, so nothing cross-tenant can be referenced.
6. **Additive `0003_tasks` migration with a clean down; `tasks` graduates out of the stub file.** The migration adds `description`/`labels`/`updated_at` + the status `CHECK` to `tasks` and creates the three new tables; the down reverses all of it (CI down/up step green). In the Drizzle schema `tasks` moves from `schema/stubs.ts` into its own `schema/tasks.ts`; `memories`/`memory_edges`/`permissions` stay stubs.

## Enforcement / surface map
| Endpoint | Access |
|---|---|
| `POST/GET /workspaces/:wid/tasks`, `GET …/tasks/board`, `…/task-routing-rules`, `…/links/:type/:id/tasks` | workspace member (`assertWorkspace`) |
| `GET /tasks/:tid`, `PATCH …/status`, `POST …/assign`, `GET …/events`, `*/links*` | `requireTaskInWorkspace` (404 cross-workspace) |
| status change | `canTransition` (409 on invalid/no-op) |
| assign / routing target / link target | workspace-validated member/object (404 cross-workspace) |

## Consequences
- **Positive:** A complete coordination primitive — validated lifecycle, immutable auditable history that survives reassignment, capability-based auto-routing that load-balances across agents, and bidirectional links into messages/memories. Routes stay thin (one access helper, pure transition/selection functions, logic in the repo). Additive migration with a clean down; every prior suite stays green.
- **Costs / deferred:** **Realtime push** of task events to open WebSocket sessions (#5 surface) is out of scope — "live" here means read-after-write + the event log, no caching (mirroring #9's "immediate"). **`file` link targets** wait for a files table. **Per-task RBAC** beyond workspace membership, **task comments/subtasks/due-dates**, and an **MCP task surface** are future work. The `memories` repo is a deliberate thin shim for link validation; the full typed graph is #15.
- **Security posture:** Cross-workspace access/assignment/routing/linking are all closed and covered by the integration IDOR test; status transitions are constrained in code *and* at the DB; the audit log is append-only. Wants a `security-and-hardening` review pass and stays exempt from auto-merge (Gagan approves on the video).

## Alternatives considered
- **Mutable `assignee` + `updated_by`/`updated_at` only (no events):** simpler, but loses history on reassignment — fails the "preserves history" acceptance. Rejected for event sourcing.
- **Agent `capabilities` column matched against task labels:** would require schema on `agents` and a matching language; the rule table is more flexible (many labels → many agents, n:m) and keeps #9's agent model untouched. Rejected in favor of routing rules.
- **First-come / random routing:** non-deterministic and ignores load. Least-loaded with an id tie-break is reproducible and fair. Rejected.
- **Channel-scoped task RBAC (reuse #9 grants):** tasks aren't channel children; overloading channel grants would be wrong. Deferred a dedicated model instead.
