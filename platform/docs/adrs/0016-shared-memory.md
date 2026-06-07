# ADR-0016: Shared memory access across agents + task/file linking

- **Status:** Accepted (defaults chosen — issue #16, "use defaults and go")
- **Date:** 2026-06-07
- **Context issue:** [#16](https://github.com/gagan114662/agent-skills/issues/16)
- **Builds on:** [ADR-0015](0015-memory-graph.md) (the typed memory graph), [ADR-0014](0014-tasks.md) (`task_links`), [ADR-0009](0009-registry-rbac.md) (the `read < write < propagate` RBAC ladder), [ADR-0003](0003-auth-identity.md) (workspace IDOR discipline)

## Context
#15 made the memory graph live but left it **workspace-readable with no RBAC** (ADR-0015 §5 explicitly deferred "channel/workspace RBAC over memory" to a later issue — this is it). The reload.chat reference is "shared memory across agents; tasks linked to memories/files; context that doesn't go stale." #16 turns the graph into a **shared, governable coordination resource**: any agent reads what another agent decided/learned, a task carries its relevant context, and a contradicted memory is versioned rather than overwritten.

## Decisions

1. **Memory is one RBAC resource per workspace — reuse #9, no new table.** The graph is treated as a single resource: `permissions.resource_type='memory'`, `resource_id=workspace_id` (`resource_type` is free text, so this needs no migration). The `requireMemoryCapability` guard layers the #9 ladder on workspace membership with a **kind-aware default**: a **human** member defaults to `propagate` (administers the graph), an **agent** member defaults to `write` (collaborates by default — this *is* the "shared, not siloed" property), and either can carry an explicit grant (e.g. an agent deliberately downgraded to `read`). `read` gates queries/traversal, `write` gates node/edge/link/supersede writes, `propagate` gates grant administration. This preserves #15 behaviour (a human owner keeps full access; existing tests unchanged) while making access governable. Per-node ACLs were rejected as grant-table explosion for no concrete requirement.

2. **task↔memory reuses #14 `task_links` unchanged; #16 adds the memory-side reverse view.** task↔memory linking already existed (`task_links.target_type='memory'`, validated in-workspace, resolving both ways). Rather than a second link table, #16 reuses it and adds `GET …/memories/:id/tasks` (delegating to `listTasksLinkingTo`) so the relationship is navigable from the memory side too.

3. **memory↔file links target a path string (no files table yet).** There is no first-class files subsystem, so a `memory_files` row links a node to a **file path** — the stable identifier available today. Workspace-scoped, idempotent per `(workspace, memory, path)`, `ON DELETE CASCADE` with the memory, resolving both ways (by memory → files; by path → memories, via the existing `?file=` filter on the list route). When a files table lands, both `memory_files` and `task_links.target_type='file'` can point at it; today the path is the target. **task↔file links and the files table are out of scope** (recorded below).

4. **Relevant-context = linked + neighbors + label-matches, ranked by a pure function.** `GET …/tasks/:tid/context` returns the memories an agent should load: the task's linked nodes (#14), their 1-hop graph neighbors (#15), and nodes whose `entity` matches a task label. The ordering/dedup/stale-filtering is a **pure, unit-tested** function (`memory/context.ts`): priority `linked > neighbor > label-match`, first-occurrence-wins dedup, superseded nodes dropped unless `?includeStale=true`. Each entry carries a `reason`. Kept deliberately deterministic/explainable rather than embedding-based — "sensible context" without an ML dependency; semantic ranking is the upgrade path.

5. **Supersede versions a node; the old one is kept, not deleted.** A node gains `superseded_by_memory_id` (self-FK, `ON DELETE SET NULL`) + `superseded_at`. `POST …/memories/:id/supersede` upserts the replacement (dedup-aware), stamps the old node, and writes a `new --supersedes--> old` edge (the #15 canonical relation, so lineage is traversable). The old node **stays** (history) but leaves `listMemories` / relevant-context by default; `?includeStale=true` and fetch-by-id still surface it. Contradiction *detection* stays out — supersede is an explicit operation, not inferred.

6. **MCP transport deferred — REST is the shared-access API.** The issue mentions "REST + MCP", but no MCP server exists in this codebase yet. The workspace-scoped REST surface *is* the shared-memory API; an MCP server can wrap it later without schema change. Recorded as deferred rather than stubbed.

7. **Thin routes, logic in `memory/*` + repo.** Every route authenticates, calls the single `requireMemoryCapability` gate, validates, and delegates. Ranking lives in `memory/context.ts`; supersede/file/context assembly in `db/repositories/memories.ts`; the RBAC default in `auth/access.ts`.

## Schema (migration `0007_shared_memory`, additive + reversible)
`memories` gains `superseded_by_memory_id` (self-FK) + `superseded_at`, and a partial index `memories_workspace_live_idx … WHERE superseded_by_memory_id IS NULL` for the default live-node listing. New table `memory_files` (`id`, `workspace_id`, `memory_id` FK cascade, `path`, `created_by_member_id`, `created_at`) with `UNIQUE (workspace_id, memory_id, path)` and forward/reverse indexes. RBAC needs **no** schema change (reuses `permissions`). The down migration drops the table, index, and columns; verified up→down→up on a clean database.

> **Parallel-migration note.** Numbered `0007_shared_memory` — the next free slot after #6 (`0006_threads_mentions`); a sibling holds `0025`. All additive and order-independent. Because the migration runner reverts by lexical name (so `db:rollback` on the shared dev Postgres targets the highest-numbered sibling, `0025`, not `0007`), `0007`'s up/down is verified by applying its SQL directly against a clean throwaway database — which is what CI does. (The shared Conductor dev Postgres also carries a sibling's divergent schema, e.g. a `0003_tasks` and a NOT-NULL `dedupe_key`; this issue's tests run against an isolated database to stay deterministic.)

## Endpoints
| Endpoint | Cap | Purpose |
|---|---|---|
| `POST …/memories/:id/supersede` | write | version a node — mark old stale (kept), link `supersedes` |
| `GET …/memories/:id/tasks` | read | reverse resolve: tasks linking to this memory |
| `POST/DELETE/GET …/memories/:id/files` | write/write/read | link / unlink / list file paths for a memory |
| `GET …/memories?file=<path>` | read | reverse resolve: memories linked to a file path |
| `GET …/memories?includeStale=true` | read | include superseded nodes (excluded by default) |
| `GET …/tasks/:tid/context` | read | relevant-context bundle (linked + neighbors + label-match) |
| `POST/DELETE/GET …/memory/grants` | propagate/propagate/read | administer memory RBAC grants |
| (existing #15 memory routes) | read/write | now gated by `requireMemoryCapability` |

## Consequences
- **Positive:** the memory graph becomes a shared, permissioned coordination surface — agents read each other's decisions by default, can be governed down to read-only, link memory to tasks (both ways) and files, pull task-relevant context, and version contradicted facts without losing history. All workspace-isolated; additive migration with a clean down; the ranking core is pure and unit-tested.
- **Costs / deferred:** RBAC granularity is the whole workspace graph, not per-node (a deliberate simplicity trade); relevant-context ranking is rule-based, not semantic; supersede is explicit, not auto-detected; file links target a path string pending a files table; MCP transport is deferred to a wrapper. task↔file links wait on that files table.
- **Security posture:** every route authenticates and passes one `requireMemoryCapability` gate carrying both the IDOR boundary (cross-workspace → 403, foreign node → 404) and the capability ladder; the integration matrix covers agent↔agent sharing, RBAC downgrade, both link directions, and cross-workspace rejection on every new surface. Wants a `security-and-hardening` pass and stays exempt from auto-merge — **Gagan approves on the video.**
