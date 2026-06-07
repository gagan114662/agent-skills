# Spec: Reload Platform — Shared Memory Access + Task/File Linking (Issue #16)

> Implements [#16](https://github.com/gagan114662/agent-skills/issues/16). Phase 3 — Coordination. Depends on **#15** (the typed `memories` / `memory_edges` graph + `upsertMemory`/`getMemory`/`listMemories`/`upsertEdge`/`getNeighbors`), **#14** (`task_links` — task↔{message,memory} links that resolve both ways), and **#9** (the `permissions` RBAC ladder `read < write < propagate`).
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Builds on [ADR-0015](../adrs/0015-memory-graph.md), [ADR-0014](../adrs/0014-tasks.md), [ADR-0009](../adrs/0009-registry-rbac.md). Records [ADR-0016](../adrs/0016-shared-memory.md). Default posture for this issue: **"use defaults and go"** — no UI, REST surface only.

## Objective

**What:** Turn the #15 memory graph from a workspace-readable store into a **shared, permissioned coordination resource**:

1. **Shared, RBAC-guarded read/write** — every agent and human in a workspace reads and writes the *same* memory graph (not siloed per-agent), gated by the #9 capability ladder applied to a new `memory` resource. The graph is shared by default; a member can be deliberately downgraded (e.g. an agent restricted to read-only).
2. **Linking + bidirectional resolve** — task↔memory (reuse #14 `task_links`, plus the memory-side reverse view) and the genuinely new **memory↔file** links.
3. **Relevant-context retrieval** — given a task, return the memories an agent should load as context (linked nodes + their graph neighbors + label/entity matches), staleness-filtered.
4. **Supersede / version on contradiction** — a newer memory can supersede an older one; the old node is **marked stale, never deleted**, and a `supersedes` edge records the lineage.

**Why:** This is the reload.chat property "shared memory across agents; tasks linked to memories/files; context that doesn't go stale." Agents coordinate by reading what other agents already decided/learned instead of re-deriving it, and a task carries its relevant context with it.

**Who:** Any workspace **member** (#3) — humans (cookie) and agents (Bearer). Memory access is **workspace-scoped** (the #3 IDOR discipline): sharing is *within* a workspace, never across.

## The model

### Memory as an RBAC resource
The #9 `permissions` table is `(member, resource_type, resource_id) → capability`. We treat the **workspace memory graph** as a single resource: `resource_type = 'memory'`, `resource_id = workspace_id`. No new table — `resource_type` is free text.

Effective capability (mirrors the #9 channel model, layered on workspace membership):

| Caller | No explicit grant | Explicit grant |
|---|---|---|
| non-member | `null` (403) | — |
| **human** member | `propagate` (owns/administers the graph) | the grant |
| **agent** member | `write` (shares read/write — the coordination default) | the grant (e.g. downgrade to `read`) |

Rationale: humans administer; agents collaborate by default (`write`) but can be restricted to `read`. This preserves #15 behaviour (a human owner keeps full access) while making "shared but governable" real. `read` is required to query/traverse, `write` to create nodes/edges/links/supersede, `propagate` to administer grants.

### Linking
- **task ↔ memory** — already modelled by #14 `task_links` (`target_type='memory'`, validated in-workspace, resolves both ways via `listTaskLinks` / `listTasksLinkingTo`). #16 **reuses it unchanged** and adds the memory-side convenience view `GET …/memories/:id/tasks`.
- **memory ↔ file (new)** — a `memory_files` row links a memory node to a **file path** (text — there is no files table yet; a path is the stable identifier). Workspace-scoped, idempotent (`UNIQUE (workspace_id, memory_id, path)`), resolves both ways: by memory → its files, and by path → the memories about it. ON DELETE CASCADE with the memory.

  > *Out of scope:* task↔file links and a first-class files table. When a files subsystem lands, `task_links.target_type='file'` and `memory_files` can both point at it; today the path string is the link target. Recorded in ADR-0016.

### Relevant-context retrieval
`GET /workspaces/:wid/tasks/:tid/context` returns a deterministic, explainable bundle of memories for a task:

```
linked      = memories task_links → this task          (reason: "linked")
neighbors   = 1-hop graph neighbors of the linked set  (reason: "neighbor")
labelMatch  = memories whose entity ∈ task.labels       (reason: "label-match")
context     = rank(linked ++ neighbors ++ labelMatch)   // dedup by id, drop stale, linked first
```

`rank` is a **pure function** (`memory/context.ts`, unit-tested): concatenate in priority order (linked > neighbor > label-match), keep the first occurrence of each id, and drop any superseded (stale) node. "Sensible" = the things explicitly tied to the task, the graph around them, and anything tagged with the task's labels — minus stale.

### Supersede / version
A node gains two columns: `superseded_by_memory_id` (self-FK, nullable) and `superseded_at`. `POST /workspaces/:wid/memories/:id/supersede` (write) creates/【upserts】the replacement node, sets the old node's `superseded_by_memory_id` + `superseded_at`, and writes a `new --supersedes--> old` edge (the #15 canonical relation). The old node is **retained** (history/lineage) but excluded from `listMemories` and relevant-context by default; `?includeStale=true` surfaces it. Reading the old node by id still returns it, now carrying its `supersededByMemoryId`.

## REST surface

All routes are workspace-scoped and pass the capability gate above (cross-workspace → 403; node not in workspace → 404).

| Method & path | Cap | Purpose |
|---|---|---|
| `POST /workspaces/:wid/memories` | write | create node (existing #15, now write-gated) |
| `GET /workspaces/:wid/memories` `?type=&entity=&file=&includeStale=` | read | query nodes (now read-gated; `file=` resolves memories for a path; `includeStale` opt-in) |
| `POST /workspaces/:wid/memories/capture` | write | auto-capture (existing #15, now write-gated) |
| `GET /workspaces/:wid/memories/:id` | read | node + neighbors (existing #15) |
| `POST /workspaces/:wid/memories/:id/edges` | write | typed edge (existing #15, now write-gated) |
| `POST /workspaces/:wid/memories/:id/supersede` | write | **new** — supersede old node with a replacement |
| `GET /workspaces/:wid/memories/:id/tasks` | read | **new** — tasks linking to this memory (reverse) |
| `POST /workspaces/:wid/memories/:id/files` | write | **new** — link a file path |
| `DELETE /workspaces/:wid/memories/:id/files` | write | **new** — unlink a file path |
| `GET /workspaces/:wid/memories/:id/files` | read | **new** — files linked to this memory |
| `GET /workspaces/:wid/tasks/:tid/context` | read | **new** — relevant-context bundle for a task |
| `POST /workspaces/:wid/memory/grants` | propagate | **new** — grant/upsert a member's memory capability |
| `DELETE /workspaces/:wid/memory/grants/:mid` | propagate | **new** — revoke a member's grant |
| `GET /workspaces/:wid/memory/grants` | read | **new** — list explicit grants |

## PLAN — atomic tasks (each independently buildable & testable)

1. **Migration 0007 + schema** — `memories.superseded_by_memory_id` / `superseded_at`; `memory_files` table. Additive, paired down.
2. **Repo** — `MemoryNode` carries `supersededByMemoryId`; `listMemories` gains `includeStale`; add `supersedeMemory`, `linkMemoryFile` / `unlinkMemoryFile` / `listFilesForMemory` / `listMemoriesForFile`.
3. **RBAC** — `requireMemoryCapability(identity, wid, needed, reply)` in `auth/access.ts`; gate all memory routes; grant admin routes.
4. **Linking + reverse** — memory→tasks view (reuse `listTasksLinkingTo`); file link routes.
5. **Relevant-context** — pure `rankRelevantContext` (`memory/context.ts`) + repo assembly + route.
6. **Supersede** — repo + route + stale exclusion wiring.

## BUILD — TDD acceptance (red → green)

- **Shared (agent↔agent):** agent A writes a decision; agent B in the **same** workspace reads & traverses it. ✓
- **RBAC downgrade:** an agent granted `read` can read memory but `POST` is `403`; default agents write fine.
- **Linking both ways:** link memory↔task → appears in the task's links *and* in the memory's `/tasks` view; link memory↔file → appears by-memory *and* by-path.
- **Relevant context:** a task's `/context` returns its linked memory + that memory's neighbor, excludes a stale node, tags reasons. (pure `rank` unit-tested separately)
- **Supersede:** superseding marks the old node stale (`supersededByMemoryId` set), it drops out of the default list but is still fetchable, and the new node carries a `supersedes` edge.
- **Cross-workspace (IDOR):** every new route rejects a caller from another workspace (403/404).

## Out of scope
- MCP transport (no MCP server exists in this codebase yet — the REST surface *is* the shared-access API; MCP can wrap it later). Recorded in ADR-0016.
- A first-class files table / task↔file links (path-as-identifier today).
- Automatic contradiction *detection* — supersede is an explicit operation, not an inferred one.
- Per-node ACLs — capability is at the workspace-graph granularity (matches #9's per-resource model without exploding the grant table).
