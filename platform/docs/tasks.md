# Tasks (Linear-style task system) — #14

Humans and agents create, assign, hand off, and progress work. Every task is workspace-scoped; every state change is an immutable event. See [ADR-0014](adrs/0014-tasks.md) and the [spec](specs/14-tasks.md).

## Status lifecycle
`backlog → todo → in_progress → {blocked, done}`, plus `canceled`, plus reopen of a terminal task to `todo`. Transitions are validated (`src/tasks/status.ts`) and also constrained by a DB `CHECK`. A no-op or illegal transition is `409`.

| from | allowed `to` |
|---|---|
| `backlog` | `todo`, `in_progress`, `canceled` |
| `todo` | `in_progress`, `backlog`, `canceled` |
| `in_progress` | `blocked`, `done`, `todo`, `canceled` |
| `blocked` | `in_progress`, `canceled` |
| `done` / `canceled` | `todo` (reopen) |

## Assignment & history
One assignee per task (human or agent member). Assigning, reassigning, and unassigning each append a `task_events` row. **Assignment history = the ordered `assigned`/`reassigned`/`unassigned` events** — reassignment never loses the chain. Events also cover `created`, `status_changed`, `linked`, `unlinked`, and are written in the same transaction as the change (append-only; never mutated).

## Auto-routing
A routing rule maps a `label` → an eligible agent member (the label is the capability/role). Auto-routing a task gathers every active agent targeted by a rule whose label is in the task's labels, then assigns the **least-loaded** one (fewest open tasks; deterministic id tie-break). No matching rule → the task stays unassigned (never an error).

## Links (both ways)
A task links to a `message` or `memory` (polymorphic; `file` later). Forward: `GET /tasks/:tid/links`. Reverse: `GET /workspaces/:wid/links/:type/:targetId/tasks`. Link targets are workspace-validated; links are idempotent.

## Views
- **Board:** `GET /workspaces/:wid/tasks/board` → `{ [status]: Task[] }`.
- **By assignee:** `GET /workspaces/:wid/tasks?assignee=:memberId` (also `?status=`).

## Endpoints
```
POST   /workspaces/:wid/tasks                    { title, description?, labels?, assigneeMemberId?, autoRoute? }
GET    /workspaces/:wid/tasks                     ?status= &assignee=
GET    /workspaces/:wid/tasks/board
GET    /tasks/:tid
PATCH  /tasks/:tid/status                         { status }
POST   /tasks/:tid/assign                         { assigneeMemberId? | autoRoute? }
GET    /tasks/:tid/events
POST   /tasks/:tid/links                          { targetType, targetId }
DELETE /tasks/:tid/links/:type/:targetId
GET    /tasks/:tid/links
GET    /workspaces/:wid/links/:type/:targetId/tasks
POST   /workspaces/:wid/task-routing-rules        { label, agentMemberId }
GET    /workspaces/:wid/task-routing-rules
DELETE /workspaces/:wid/task-routing-rules/:ruleId
```

## Access
Workspace membership gates everything (no per-task RBAC yet). `requireTaskInWorkspace` is the single access call task-id routes make; cross-workspace task access, assignment, routing, and linking are all `404`/`403`. Carries the #3 IDOR discipline.
