# Spec: Reload Platform — Typed Context/Memory Graph + Auto-Capture (Issue #15)

> Implements [#15](https://github.com/gagan114662/agent-skills/issues/15). Phase 3 — Coordination. Depends on #2 (data model — the `memories` / `memory_edges` stub tables), #3 (auth/identity — workspace-scoped IDOR discipline).
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Builds on [ADR-0002](../adrs/0002-data-model.md) and [ADR-0003](../adrs/0003-auth-identity.md). Records [ADR-0015](../adrs/0015-memory-graph.md). No code until approved (the user instruction for this issue is **"use defaults and go"**).

## Objective
**What:** A **typed context/memory graph** — memory **nodes** each carrying a `type` (`decision` / `fact` / `preference` / `artifact`, extensible) and a jsonb body, connected by **typed edges** (`relation`) — plus an **auto-capture** pipeline that turns a piece of workspace activity (a message/event) into typed nodes + edges through a **pluggable extractor** (LLM-assisted behind an interface, with a deterministic rule-based fallback as the default). Includes **dedup/merge** so obvious duplicates collapse to one node, and a **query/traversal API** (by type, by entity, and node→neighbors).

**Why:** This is the reload.chat "auto-captured typed Context Graph" — the substrate that lets agents and humans accumulate durable, structured memory (decisions made, facts learned, preferences stated, artifacts produced) instead of re-reading raw chat history. #2 deliberately shipped `memories` / `memory_edges` as **stub tables** (id, workspace_id, type, content / from→to, relation) with the note *"extended by #15"*; this issue makes them live with a real write/query surface.

**Who:** Any workspace **member** (#3) — humans (session cookie) and agents (Bearer token) alike. Memory is **workspace-scoped**, not channel-scoped, so the access gate is workspace membership (`assertWorkspace`), consistent with #9 deferring workspace-wide/org roles. Channel-level RBAC (#9) is not applied here (see Out of scope).

## The model

A **node** is a `memories` row: a typed, deduplicated statement about the workspace.

| Field | Meaning |
|---|---|
| `type` | node kind — canonical set `decision` / `fact` / `preference` / `artifact`, **extensible** (free text; the four are validated/used by the extractor, manual creation may pass others) |
| `content` jsonb | the body; always carries a `text` field (the canonical human-readable statement) plus optional extra keys |
| `entity` | a normalized subject the node is *about* (e.g. `auth`, `deploy`), nullable — powers "query by entity" |
| `source_type` / `source_id` | **provenance**: the kind + id of the workspace activity a node was captured from (`message` / `task` / `file` / `event` / `manual`), nullable |
| `dedupe_key` | deterministic normalized hash of `(type, entity, canonical text)` — the dedup/merge key |
| `created_by_member_id` | who/what captured it (nullable, `ON DELETE SET NULL`) |

An **edge** is a `memory_edges` row: a typed, directed link `from_memory_id → to_memory_id` with a `relation` (canonical: `relates_to`, `supports`, `supersedes`, `derived_from`; extensible). Both endpoints are real `memories` rows in the **same workspace** (FK-enforced), so the graph keeps referential integrity.

### Cross-resource links = provenance columns, not polymorphic edges
The issue lists "edges to memories/messages/tasks/files". We model node↔node links as real `memory_edges` (FK integrity) and model a node's link to its **source** activity (a message/task/file/event) as the `source_type` + `source_id` **columns on the node**. Rationale: a polymorphic edge target (one column pointing at any of four tables) cannot carry a foreign key and silently rots; provenance-as-columns is type-checked at the app layer, keeps `memory_edges` strictly memory↔memory, and is exactly what auto-capture needs ("this fact came from that message"). Recorded in ADR-0015.

### Dedup / merge
`dedupe_key = sha256( normalize(text) ⊕ type ⊕ (entity ?? "") )`, where `normalize` lowercases, trims, and collapses internal whitespace. A `UNIQUE (workspace_id, dedupe_key)` makes writes **idempotent**: capturing or posting the same statement twice resolves to the **same** node (the first one's provenance is kept; the write is a no-op merge). Edges dedup the same way via `UNIQUE (workspace_id, from_memory_id, to_memory_id, relation)`. The key intentionally **excludes** `source`, so the same fact arriving from two different messages collapses to one node.

### Auto-capture pipeline
```
captureFromSource({ workspaceId, text, sourceType, sourceId, createdByMemberId }, extractor?)
  → extractor.extract({ text })           // → { memories:[{type,text,entity?}], edges:[{fromIndex,toIndex,relation}] }
  → planCapture(extraction)               // pure: resolve edge indices, attach provenance
  → upsertMemory × N  (dedup)             // returns node ids + created flags
  → upsertEdge   × M  (dedup)             // maps planned indices → resolved node ids
  → { memories, edges }
```
- **`MemoryExtractor`** is the pluggable interface. The **default** is `DeterministicExtractor` — rule-based, hermetic, no network: it splits `text` into statements and classifies each by lexical cues (`decided/we will/let's` → `decision`; `prefer/please always/from now on` → `preference`; a URL or file path → `artifact`; otherwise → `fact`), pulls an `entity` from a leading `#tag` if present, and links every non-anchor statement to the first (anchor) statement with a `relates_to` edge (so a multi-statement message yields **nodes + edges**).
- **`LlmExtractor`** implements the same interface over an injected `LlmClient` (a one-method `complete(prompt)` port). It is wired but **inert unless a client is injected** — no key, no network in CI; the deterministic extractor is the production default. This satisfies "LLM-assisted extraction behind an interface + deterministic fallback".

## Endpoints (all require #3 auth, all workspace-scoped via `assertWorkspace`)
```
POST   /workspaces/:wid/memories                 { type, text, entity?, content? }     create a typed node (manual); dedup → 201 new / 200 merged
GET    /workspaces/:wid/memories?type=&entity=                                          query nodes by type and/or entity
GET    /workspaces/:wid/memories/:id                                                    node + neighbors (1-hop traversal: incoming/outgoing edges + neighbor nodes)
POST   /workspaces/:wid/memories/:id/edges       { toMemoryId, relation }               create a typed edge; both endpoints must be in :wid (else 404); dedup
POST   /workspaces/:wid/memories/capture         { text, sourceType?, sourceId? }       auto-capture: extract typed nodes + edges from text → { memories, edges }
```
Routes stay **thin**: each authenticates (`requireIdentity`), asserts the workspace (`assertWorkspace`), validates the body, and delegates to the repo / capture service. All extraction, dedup, and traversal logic lives in `memory/*` + the repo.

## Schema & migration (`0005_memory`, additive — paired up/down)
The `memories` / `memory_edges` stubs already exist from #2 (0000_init). `0005_memory.sql` adds, on `memories`: `entity text`, `source_type text` (+ CHECK in `message|task|file|event|manual`), `source_id uuid`, `dedupe_key text` (nullable — #14's `createMemory()` task-link shim inserts without it; a NULL never collides under the UNIQUE, while graph writes always supply one), `created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL`; `UNIQUE (workspace_id, dedupe_key)`; indexes on `(workspace_id, type)` and `(workspace_id, entity)`. On `memory_edges`: `created_by_member_id` (same FK), `UNIQUE (workspace_id, from_memory_id, to_memory_id, relation)`, and traversal indexes on `from_memory_id` and `to_memory_id`. `0005_memory.down.sql` reverses all of it. `type` and `relation` stay **free text** (no CHECK) to honor "extensible". Mirrored in `db/schema/stubs.ts` (drizzle), consistent with how #9 extended the `permissions` stub in place.

> **Parallel-migration note:** sibling issues landed migrations concurrently — #7 (search) took `0003_search`, and `0004` is claimed by another sibling — so this migration is numbered **`0005_memory`** (the next free slot after merging `origin/main`). All these migrations are additive and order-independent. Local `db:rollback` against the shared dev Postgres can target a sibling's later-numbered migration (lexical-name ordering); up/down of `0005_memory` is therefore verified on a clean throwaway DB — exactly what CI does.

## Service / repo layer (routes stay thin)
- `memory/extract.ts`: `MemoryExtractor`, `DeterministicExtractor`, `LlmExtractor` + `LlmClient` (pure / injected).
- `memory/dedupe.ts`: `dedupeKey(type, text, entity)` + `normalizeText` (pure).
- `memory/capture.ts`: `planCapture(extraction)` (pure) + `captureFromSource(...)` (orchestrates repo upserts).
- `db/repositories/memory.ts`: `upsertMemory` (dedup → `{ id, created }`), `upsertEdge` (idempotent), `getMemory`, `listMemories({ type?, entity? })`, `getNeighbors` — all workspace-scoped.
- `routes/memory.ts`: the five thin endpoints above; registered in `app.ts`.

## Testing strategy
- **Unit (hermetic, in `pnpm test`):**
  1. `DeterministicExtractor` classifies decision / fact / preference / artifact and emits anchor `relates_to` edges (nodes **and** edges).
  2. `dedupeKey` normalization — same text differing in case/whitespace → same key; different `type` or `entity` → different key.
  3. `planCapture` with a **`StubExtractor`** — extractor is pluggable; planned edges resolve the right node indices (this is the "extraction pluggable; unit-tested w/ stub" criterion, kept DB-free).
- **Integration (real Postgres, `test:integration`) — the #15 acceptance matrix:**
  1. Create typed nodes (a `decision` + a `fact`) and a typed edge between them; `GET /memories/:id` returns the node **+ neighbors**.
  2. **Auto-capture** a memory from a source (`POST /capture` with `sourceType=message`) → a typed node exists carrying that provenance.
  3. **Dedup** — capturing/creating the same statement twice yields **one** node.
  4. **Cross-workspace** access is rejected: workspace B cannot read/write workspace A's memories (403), and an edge whose target node is in another workspace is rejected (404).

## Boundaries
- **Always:** authenticate every endpoint (#3); scope every query, write, and edge endpoint by `identity.workspaceId`; keep routes thin (logic in `memory/*` + repo); make writes idempotent (dedup); write the failing test first; attach the demo video.
- **Ask first:** applying channel/workspace RBAC (#9) to memory; making edges polymorphic across messages/tasks/files; adding a real networked LLM extractor in CI.
- **Never:** let a member read or write another workspace's memory; create an edge across workspaces; cache identity/workspace decisions; add a hard `type`/`relation` CHECK that breaks extensibility; call a network LLM in tests.

## Success criteria
1. Acceptance matrix (1–4 above) green in the `integration` job against real Postgres.
2. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass from `platform/`.
3. `0003_memory` applies and reverses cleanly (verified up→down→up on a clean DB); prior migrations + tests unchanged and green.
4. Extraction is pluggable (interface + deterministic default + LLM impl), unit-tested with a stub; routes hold no extraction/dedup logic.
5. ADR-0015 records the typed-graph + provenance-columns + dedup-key decisions; `platform/docs/memory-graph.md` documents the model; demo `platform/docs/demos/15-memory-graph.mp4` walks the acceptance matrix.

## Open questions (defaults chosen — instruction for this issue is "use defaults and go")
1. **Cross-resource links modeled as provenance columns** (`source_type`/`source_id`) on the node, with `memory_edges` kept strictly memory↔memory for FK integrity. OK?
2. **Dedup key = `sha256(normalize(text) ⊕ type ⊕ entity)`**, excluding provenance, with a UNIQUE for idempotent merge. OK?
3. **Memory is workspace-scoped** (any member reads/writes); channel/workspace RBAC deferred to a later issue. OK?
4. **`type`/`relation` left as free text** (extensible) rather than DB CHECK; the four canonical types drive the extractor. OK?
5. **LLM extractor wired behind an interface but inert in CI**; deterministic extractor is the default. OK?
