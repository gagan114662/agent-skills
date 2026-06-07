# ADR-0007: Permission-scoped search (messages & channels)

- **Status:** Accepted (defaults chosen — issue #7; security-sensitive: no-leakage is the headline guard)
- **Date:** 2026-06-06
- **Context issue:** [#7](https://github.com/gagan114662/agent-skills/issues/7)
- **Builds on:** [ADR-0004](0004-channels-dms.md) (channels/messages/membership), [ADR-0009](0009-registry-rbac.md) (read/write/propagate — the access model this reuses), [ADR-0003](0003-auth-identity.md)/[ADR-0019](0019-deploy-observability.md) (workspace scoping & IDOR discipline)

## Context

Core chat had channels (#4), realtime (#5), and roles (#9) but no way to _find_ anything. reload.chat parity needs ranked full-text search with channel/author/date/thread filters. The dominant constraint is access: search reads across **many** channels at once, so it is the easiest place to accidentally leak a message that `GET /channels/:cid/messages` otherwise protects. Search must apply the **same** read boundary, fanned out over a set of channels.

## Decisions

1. **Search = read, expressed as one SQL predicate.** The readable set is `channel_id IN (SELECT channel_id FROM channel_members WHERE member_id = :caller)`. Under the #9 model (ADR-0009 §2) a non-member has no access and every capability rung (`read`/`write`/`propagate`) satisfies `read`, so "channels the caller is a member of" **is** the projection of `effectiveCapability ≥ read`. We scope as a set-shaped predicate, **not** an N+1 `requireChannelCapability` per row — same decision, one indexed query. The membership sub-select is the single place to tighten if a future "banned/none" rung is added below `read`.
2. **Postgres FTS via a `GENERATED … STORED` `tsvector` column + GIN index.** `0003_search` adds `body_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED` and `messages_body_tsv_idx … USING GIN`. Postgres recomputes the column on every `INSERT`/`UPDATE` of `body` and drops the index entry on `DELETE`, so the **"index stays correct across edits/deletes"** acceptance criterion needs _zero_ maintenance code — no trigger, no app-side denormalization. Soft-deletes are filtered at query time (`deleted_at IS NULL`). Rejected alternatives: query-time `to_tsvector(body)` (seq scan + per-row tokenization, no index) and a maintenance trigger (more moving parts to get wrong).
3. **`websearch_to_tsquery('english', q)` + `ts_rank`.** `websearch_to_tsquery` accepts arbitrary user input (quotes, `or`, `-`) and never throws on malformed syntax — the right parser for a public `q`. Results order by `ts_rank` DESC then `created_at` DESC. Offset pagination; `limit` clamped to `[1,100]` (default 20).
4. **Filters compose (AND) and never widen access.** `channelId`, `authorMemberId`, `before`/`after`, `threadId` further constrain the already-scoped set. An **unreadable `channelId` filter returns empty** — no 403/404 — so search is not an existence oracle for channels the caller can't see. Validation is forgiving (limit/offset clamped, not 400); only a missing `q` is a 400.
5. **New module, no churn.** `routes/search.ts` + `db/repositories/search.ts` are additive; `routes/channels.ts` and `repositories/messages.ts` are untouched. Routes stay thin (auth → `assertWorkspace` → parse → repo). The pure `parseSearchParams` helper is unit-tested without Fastify.
6. **Scope = "what you can already read."** Channel-name search is restricted to the caller's (non-archived) channels; member-name search is workspace-scoped. Message search includes archived channels' messages (they remain readable via `GET messages`), but channel-name search excludes archived (mirrors `GET /workspaces/:wid/channels`). **No new dependency.**

## Enforcement map

| Endpoint                               | Auth                         | Scope                                                                                                           |
| -------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /workspaces/:wid/search/messages` | identity + `assertWorkspace` | `deleted_at IS NULL` ∧ `workspace_id = wid` ∧ `channel_id ∈ caller's channels` ∧ FTS match (+ optional filters) |
| `GET /workspaces/:wid/search/channels` | identity + `assertWorkspace` | non-archived ∧ `workspace_id = wid` ∧ `id ∈ caller's channels` ∧ name ILIKE                                     |
| `GET /workspaces/:wid/search/members`  | identity + `assertWorkspace` | `workspace_id = wid` ∧ display_name ILIKE                                                                       |

## Consequences

- **Positive:** RBAC parity for search with one reused predicate; ranked, indexed FTS; self-maintaining index (generated column) so edits/deletes are correct for free; additive migration with a clean paired down; zero churn to #4/#9 surfaces; no new dependency.
- **Costs / deferred:** English-only FTS config; offset (not keyset) pagination; no snippets/highlighting; no fuzzy/typo tolerance; **tasks/memories** search deferred (still stub tables, same posture as #9); "discover public channels you're not a member of" is intentionally out of scope (search returns only what you can already read — a broader discovery endpoint would be a separate decision).
- **Security posture:** the no-leakage guarantee (same-workspace non-member → empty; cross-workspace → empty/403; unreadable `channelId` filter → empty, no oracle) is pinned by the integration acceptance matrix. All SQL is parameterized including ILIKE patterns. **Security-sensitive — wants a `security-and-hardening` review and stays exempt from auto-merge (Gagan approves on the video).**

## Cross-workspace coordination note

The shared local Postgres volume across Conductor workspaces means a sibling branch's migration can sit "on top" locally, so `db:rollback` may target the sibling's file (the documented shared-volume gotcha). `0003_search`'s own down/up was verified by applying its paired SQL directly; CI proves down/up on a fresh service-container DB. `0003` is the next free number off `main`; if a sibling also lands a `0003_*`, the lexical-sort migration runner still applies both deterministically (rename is trivial if preferred at merge time).
