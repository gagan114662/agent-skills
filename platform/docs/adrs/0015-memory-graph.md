# ADR-0015: Typed context/memory graph + auto-capture

- **Status:** Accepted (defaults chosen — issue #15, "use defaults and go")
- **Date:** 2026-06-06
- **Context issue:** [#15](https://github.com/gagan114662/agent-skills/issues/15)
- **Builds on:** [ADR-0002](0002-data-model.md) (the `memories` / `memory_edges` stub tables), [ADR-0003](0003-auth-identity.md) (identity + the workspace IDOR discipline)

## Context
#2 shipped `memories` / `memory_edges` as **stub tables** (id, workspace_id, type, content / from→to, relation) explicitly marked *"extended by #15"*. The reload.chat reference is an **auto-captured typed Context Graph** — decisions, facts, preferences, and artifacts as typed nodes connected by typed edges, accumulated from workspace activity instead of re-read from raw chat. #15 makes the stubs live with a write/query surface, a dedup/merge story, and an auto-capture pipeline.

## Decisions
1. **Nodes are typed, free-text `type`.** Canonical set `decision` / `fact` / `preference` / `artifact`, but `type` (and edge `relation`) stay **free text with no DB CHECK** — the issue requires the type set to be *extensible*. The canonical four drive the extractor and docs; manual creation may pass other types. `content` is jsonb that always carries a `text` field (the canonical statement) plus optional extra keys.
2. **Cross-resource links = provenance columns, not polymorphic edges.** The issue lists "edges to memories/messages/tasks/files". We keep `memory_edges` **strictly memory↔memory** so both endpoints carry real foreign keys (referential integrity, cascade on workspace delete). A node's link to the **source** activity it was captured from is modeled as `source_type` (`message`/`task`/`file`/`event`/`manual`, CHECK-constrained) + `source_id` **columns on the node**. Rationale: a single edge column pointing at any of four tables cannot be a foreign key and silently rots; provenance-as-columns is exactly what auto-capture needs ("this fact came from that message") and is validated at the app + CHECK layer.
3. **Dedup/merge via a deterministic key.** `dedupe_key = sha256(type ⊕ entity ⊕ normalize(text))`, where `normalize` lowercases, trims, and collapses whitespace. A `UNIQUE (workspace_id, dedupe_key)` makes a node write an **idempotent merge** — posting or capturing the same statement twice resolves to the same row (`created:false`), keeping the first node's provenance. The key **excludes** provenance, so the same statement from two sources collapses to one node. Edges dedup identically via `UNIQUE (workspace_id, from, to, relation)`.
4. **Auto-capture: pluggable extractor + deterministic default.** `MemoryExtractor` is a one-method port (`extract({text}) → {memories, edges}`). The production default is the hermetic, network-free `DeterministicExtractor` (splits into statements, classifies by lexical cue, lifts an `entity` from a leading `#tag`, links each non-anchor statement to the first with a `relates_to` edge — so a multi-statement source yields nodes **and** edges). `LlmExtractor` implements the same port over an injected `LlmClient`; it is **wired but inert unless a client is injected** — no key, no network in CI. `planCapture` is a pure function (extraction → upsert plan with dedup keys + valid edges) so capture is unit-testable with a stub extractor.
5. **Workspace-scoped, not channel-RBAC'd.** Memory is **workspace-scoped**: any member of the workspace may read/write it, gated by `assertWorkspace` (the #3 IDOR guard). #9 deferred workspace-wide/org roles and noted memory enforcement would come "when those surfaces exist"; since memory isn't channel-scoped, applying channel RBAC here would be a category error. Edge creation additionally requires **both** endpoints to resolve in the caller's workspace (cross-workspace edge → 404). Channel/workspace RBAC over memory is left to a later issue.
6. **Thin routes, logic in `memory/*` + repo.** Routes authenticate, assert the workspace, validate, and delegate. All extraction, dedup, and traversal live in `memory/extract.ts`, `memory/dedupe.ts`, `memory/capture.ts`, and `db/repositories/memory.ts`.

## Schema (migration `0005_memory`, additive + reversible)
`memories` gains `entity`, `source_type` (+ CHECK), `source_id`, `dedupe_key` (NOT NULL), `created_by_member_id`, `UNIQUE (workspace_id, dedupe_key)`, and indexes on `(workspace_id, type)` / `(workspace_id, entity)`. `memory_edges` gains `created_by_member_id`, `UNIQUE (workspace_id, from, to, relation)`, and per-endpoint traversal indexes. The down migration returns both tables to their #2 stub shape; verified up→down→up on a clean database.

> **Parallel-migration note.** Sibling issues landed migrations concurrently — #7 (search) took `0003_search` and `0004` is claimed by another sibling — so this migration is numbered **`0005_memory`** (the next free slot after merging `origin/main`). All are additive and order-independent. Local `db:rollback` against the shared dev Postgres can target a sibling's later-numbered migration by lexical-name ordering, so `0005_memory`'s up/down is verified on a clean throwaway DB — which is what CI does.

## Endpoints
| Endpoint | Purpose |
|---|---|
| `POST /workspaces/:wid/memories` | create a typed node (manual); dedup → 201 new / 200 merged |
| `GET /workspaces/:wid/memories?type=&entity=` | query nodes by type and/or entity |
| `GET /workspaces/:wid/memories/:id` | node + 1-hop neighbors (incoming/outgoing edges + neighbor nodes) |
| `POST /workspaces/:wid/memories/:id/edges` | create a typed edge (both endpoints in `:wid`; dedup) |
| `POST /workspaces/:wid/memories/capture` | auto-capture: extract typed nodes + edges from text |

## Consequences
- **Positive:** a real typed graph over the #2 stubs with idempotent writes (no duplicate nodes/edges), pluggable extraction (deterministic default + LLM behind an interface), and `by-type`/`by-entity`/neighbor queries — all workspace-isolated. Additive migration with a clean down.
- **Costs / deferred:** the deterministic extractor is intentionally simple (lexical cues, line/sentence splitting) — good enough for the acceptance matrix and a sane default, not an NLP system; the LLM extractor is the upgrade path. No RBAC over memory yet (workspace membership is the gate). Provenance is soft-referenced (`source_id` is not a polymorphic FK) by design. Multi-hop / path queries and merge-on-near-duplicate (semantic, not exact) are future work.
- **Security posture:** every endpoint authenticates and is workspace-scoped; cross-workspace read/write/edge is rejected, covered by the integration acceptance matrix. Wants a `security-and-hardening` pass and stays exempt from auto-merge — **Gagan approves on the video.**
