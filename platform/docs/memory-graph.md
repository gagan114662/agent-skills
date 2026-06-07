# Typed Context/Memory Graph (issue #15)

The memory graph is the workspace's durable, structured memory: typed **nodes** (decisions, facts, preferences, artifacts) connected by typed **edges**, auto-captured from activity and queryable by type, entity, or neighbor. It makes the `memories` / `memory_edges` tables from the data model (#2) live. See [ADR-0015](adrs/0015-memory-graph.md).

## Nodes
A node is a `memories` row — a typed, deduplicated statement.

| Field | Meaning |
|---|---|
| `type` | `decision` / `fact` / `preference` / `artifact` — **extensible** (free text) |
| `content` | jsonb; always has `text` (the canonical statement), plus optional extra keys |
| `entity` | normalized subject the node is *about* (e.g. `auth`, `deploy`) — powers query-by-entity |
| `source_type` / `source_id` | **provenance**: the activity it was captured from (`message`/`task`/`file`/`event`/`manual`) |
| `created_by_member_id` | the member/agent that captured it |

## Edges
An edge is a `memory_edges` row: a directed, typed link `from → to` between two nodes **in the same workspace** (FK-enforced). Canonical relations: `relates_to`, `supports`, `supersedes`, `derived_from` (extensible). Cross-resource links to a message/task/file are modeled as the node's **provenance columns**, not edges — so edges keep referential integrity.

## Dedup / merge
A node's identity is `dedupe_key = sha256(type ⊕ entity ⊕ normalize(text))`, where `normalize` lowercases, trims, and collapses whitespace. A `UNIQUE (workspace_id, dedupe_key)` makes every write **idempotent**: posting or capturing the same statement twice resolves to the same node (response `200`, `created:false`). The key excludes provenance, so the same statement from two sources is one node. Edges dedup the same way on `(workspace, from, to, relation)`.

## Auto-capture
`POST …/memories/capture` turns text into typed nodes + edges through a pluggable `MemoryExtractor`:

- **`DeterministicExtractor`** (default, hermetic) — splits text into statements, classifies each by lexical cue (`decided/we will/let's` → decision; `prefer/please always/from now on` → preference; a URL or file path → artifact; else fact), lifts an `entity` from a leading `#tag`, and links every later statement to the first with `relates_to`.
- **`LlmExtractor`** — the same interface over an injected `LlmClient`; wired but inert unless a client is provided (no key/network in CI). The deterministic extractor is the production default.

## API
```
POST   /workspaces/:wid/memories                 { type, text, entity?, content? }   create a node (manual); 201 new / 200 merged
GET    /workspaces/:wid/memories?type=&entity=                                        query by type and/or entity
GET    /workspaces/:wid/memories/:id                                                  node + neighbors (1-hop traversal)
POST   /workspaces/:wid/memories/:id/edges       { toMemoryId, relation }             typed edge (both nodes in :wid); 201/200
POST   /workspaces/:wid/memories/capture         { text, sourceType?, sourceId? }     auto-capture typed nodes + edges
```

Every endpoint authenticates (#3) and is **workspace-scoped**: a member can only touch their own workspace's memory, and an edge target must resolve in the same workspace (cross-workspace → 403/404). Memory is not channel-RBAC'd — workspace membership is the gate.
