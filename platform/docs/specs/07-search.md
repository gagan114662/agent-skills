# Spec: Reload Platform — Search (messages & channels, permission-scoped) (Issue #7)

> Implements [#7](https://github.com/gagan114662/agent-skills/issues/7). Phase 1 — Core chat. Depends on #4 (channels/membership + messages), #9 (read/write/propagate capability), #3/#19 (workspace scoping & IDOR discipline).
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Builds on [ADR-0004](../adrs/0004-channels-dms.md) and [ADR-0009](../adrs/0009-registry-rbac.md). No code until approved.

## Objective

**What:** Permission-scoped search over a workspace's **messages**, **channels**, and **members**. A single search module exposes three read-only endpoints. Every result is scoped to the **caller**: message and channel hits only ever include channels the caller can **read**; member hits are workspace-scoped. No filter, query, or pagination value can surface a message from a channel the caller is not in.

**Why:** #4 gave us channels and messages; #5 made them realtime; #9 layered read/write/propagate roles on membership. The missing core-chat surface is _finding_ something across all of it. reload.chat parity calls for ranked full-text search with channel/author/date/thread filters. The hard requirement — and the thing the tests pin down — is that search is the **same access boundary as `GET /channels/:cid/messages`**, applied to a set of channels instead of one. Search must never become a side channel that leaks messages RBAC otherwise protects.

**Who:** Humans (session cookie) and agents (Bearer token) — both are `members` (#3). An agent searching sees exactly the channels it is a member of; a human sees exactly theirs. Search holds no special privilege.

### The access model (search = read, fanned out over many channels)

The single source of truth for "can the caller read this channel?" is already #9's `effectiveCapability` (ADR-0009 §2): a non-member has **no** access (the membership gate, ADR-0004 §2); a member's effective capability is their explicit `permissions` row or the `write` default — **every** rung of the ladder (`read`/`write`/`propagate`) satisfies `read`. Therefore, under the current model, **the caller's readable channel set is exactly the set of channels they are a member of, within their workspace**.

Search computes that set with a single membership predicate and restricts every message/channel query to it:

```
channel_id IN (SELECT channel_id FROM channel_members WHERE member_id = :caller)
```

This is implemented as a SQL predicate (a sub-select), **not** an N+1 per-row `requireChannelCapability` call — same decision, set-shaped, so it stays one indexed query. We deliberately phrase the readable-set helper in terms of membership _and_ document that it is the literal projection of `effectiveCapability ≥ read`; if a future "banned/none" rung is ever added below `read`, the helper is the one place to tighten (noted in the ADR).

| Search target      | Scope                                                  | Includes archived?                                                                                                     |
| ------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| messages           | channels the caller is a member of, in their workspace | **yes** — archived channels' messages stay readable (`GET messages` does not block on archive), so search matches that |
| channels (by name) | channels the caller is a member of, in their workspace | **no** — mirrors `GET /workspaces/:wid/channels`, which lists non-archived                                             |
| members (by name)  | members of the caller's workspace                      | n/a                                                                                                                    |

### Acceptance criteria (from #7, BUILD/TDD section)

- **Ranked, paginated message hits.** `q` runs Postgres full-text search; results ordered by relevance (`ts_rank`) then recency; `limit`/`offset` paginate; response carries enough to page deterministically.
- **Filters narrow results.** `channelId`, `authorMemberId`, `before`/`after` (date range), `threadId` (root message id) each further constrain the result set; they compose (AND).
- **Never returns inaccessible channels' messages.** The _same_ `q` that finds a message for a member of the channel returns **zero** message hits for (a) a workspace member who is **not** a member of that channel and (b) a caller in a **different** workspace (cross-tenant). This is the headline regression guard.
- **Index stays correct across edits/deletes.** Editing a message body changes what it matches; soft-deleting (`deleted_at`) removes it from results; the FTS index reflects both with no maintenance code (generated column, below).

### In scope

- `GET /workspaces/:wid/search/messages` — full-text message search + filters + pagination, permission-scoped.
- `GET /workspaces/:wid/search/channels` — channel name search (ILIKE), scoped to membership.
- `GET /workspaces/:wid/search/members` — member name search (ILIKE), workspace-scoped.
- A new `routes/search.ts` module + `db/repositories/search.ts` repo, so existing `routes/channels.ts` and `repositories/messages.ts` are not churned.
- Additive migration **0003_search** (next free number): a `GENERATED ALWAYS … STORED` `tsvector` column on `messages` + a `GIN` index, with a paired `0003_search.down.sql`.

### Out of scope (deferred)

- Searching **tasks / memories** (still stub tables, no routes — same posture as #9).
- Cursor/keyset pagination, search-result highlighting/snippets, fuzzy/typo-tolerant matching, multi-language FTS configs (we use `english`).
- Searching for **public channels you're _not_ in to discover & join** — search is strictly "what you can already read." (Channel _discovery_ would be a separate, deliberately broader endpoint; noted in the ADR.)
- Realtime/streamed search; saved searches; relevance tuning beyond `ts_rank` defaults.

## Endpoints (all require auth via #3 `resolveIdentity`; all workspace-scoped via `assertWorkspace`)

```
GET /workspaces/:wid/search/messages
      ?q=<text, required, non-empty>
      &channelId=<uuid>           filter: one channel (must be one the caller can read)
      &authorMemberId=<uuid>      filter: author
      &after=<ISO8601>            filter: created_at >= after
      &before=<ISO8601>           filter: created_at <  before
      &threadId=<uuid>            filter: parent_message_id = threadId (a thread's replies)
      &limit=<1..100, default 20>
      &offset=<>=0, default 0>

GET /workspaces/:wid/search/channels?q=<text>&limit=&offset=
GET /workspaces/:wid/search/members?q=<text>&limit=&offset=
```

**Message hit shape** (superset of the #4 message shape so existing clients can reuse it, plus search metadata):

```jsonc
{
  "query": "deploy",
  "limit": 20,
  "offset": 0,
  "results": [
    {
      "id": "...",
      "channelId": "...",
      "authorMemberId": "...",
      "parentMessageId": null,
      "body": "...",
      "createdAt": "...",
      "rank": 0.0607927,
    },
  ],
}
```

`channels`/`members` return `{ query, limit, offset, results: [...] }` with the channel / member rows.

**Validation & errors:**

- `q` missing/blank → `400 { error: "q required" }`. (We do not return the whole channel on an empty query.)
- `limit`/`offset` out of range or non-numeric → clamped to the valid range (defensive; documented), not a 400 — keeps clients forgiving.
- `channelId` filter pointing at a channel the caller can't read → it simply matches nothing (the membership predicate already excludes it); **no 403/404 that would confirm the channel exists** (avoids an existence oracle — a security choice, noted in the ADR).
- Workspace mismatch (`wid` ≠ caller's) → `403` via `assertWorkspace` (the #3/#19 IDOR gate). Unauthenticated → `401`.

## Schema & migration (0003_search, additive — paired up/down)

`messages.body` already exists (#2). `0003_search.sql` adds **no new table** — only search infrastructure on `messages`:

```sql
ALTER TABLE messages
  ADD COLUMN body_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', body)) STORED;
CREATE INDEX messages_body_tsv_idx ON messages USING GIN (body_tsv);
```

Why a **generated stored column** (not a trigger, not query-time `to_tsvector`):

- **Correctness across edits/deletes for free.** Postgres recomputes the generated column on every `INSERT`/`UPDATE` of `body`, and the row (and its index entry) vanishes on delete. The "index stays correct" acceptance criterion needs **zero** maintenance code — no trigger to get wrong, no app-side denormalization. Soft-deletes are excluded at query time via `deleted_at IS NULL`.
- **Performance.** The `GIN` index is built once over `body_tsv`; queries are `body_tsv @@ websearch_to_tsquery('english', :q)`, index-supported. Query-time `to_tsvector(body)` would force a seq scan + per-row tokenization on every search.

`0003_search.down.sql` reverses exactly:

```sql
DROP INDEX IF EXISTS messages_body_tsv_idx;
ALTER TABLE messages DROP COLUMN IF EXISTS body_tsv;
```

CI's "prove down/up clean" step must stay green. The Drizzle `messages` schema gains the `body_tsv` column typed as a customType/`sql` generated column so `drizzle-kit`/typecheck stay consistent with the DB (it is never written from the app — generated columns are read-only).

## Query construction (the headline: scoping is a SQL predicate, not app logic)

`db/repositories/search.ts`:

- `searchMessages(opts)` builds one query:
  - `WHERE deleted_at IS NULL`
  - `AND workspace_id = :wid`
  - `AND channel_id IN (SELECT channel_id FROM channel_members WHERE member_id = :caller)` ← **the access gate**
  - `AND body_tsv @@ websearch_to_tsquery('english', :q)`
  - optional: `AND channel_id = :channelId`, `AND author_member_id = :authorMemberId`, `AND created_at >= :after`, `AND created_at < :before`, `AND parent_message_id = :threadId`
  - `ORDER BY ts_rank(body_tsv, websearch_to_tsquery('english', :q)) DESC, created_at DESC`
  - `LIMIT :limit OFFSET :offset`
- `searchChannels(wid, caller, q, ...)`: `name ILIKE '%'||:q||'%'` over the caller's non-archived member channels.
- `searchMembers(wid, q, ...)`: `display_name ILIKE '%'||:q||'%'` over `members WHERE workspace_id = :wid`.

`websearch_to_tsquery` is chosen over `plainto_/to_tsquery` because it accepts raw user input safely (handles quotes, `or`, `-`) and never throws on malformed syntax — important for an endpoint taking arbitrary `q`. All values are **parameterized** (Drizzle `sql` placeholders) — no string interpolation into SQL, including `ILIKE` patterns (the `%…%` is concatenated in SQL, not in JS).

## Service/route layer (routes stay thin)

- `routes/search.ts`: three handlers; each does `requireIdentity` → `assertWorkspace` → parse/validate query → call the repo → return. No access logic inlined beyond the workspace gate; channel-level scoping lives in the repo's membership predicate.
- Registered in `app.ts` alongside `channelRoutes` (`app.register(searchRoutes)`).
- A small pure helper `parseSearchParams(query)` (clamp limit/offset, require `q`, coerce dates) is unit-tested in isolation.

## Testing strategy

- **Unit (hermetic):** `parseSearchParams` — `q` required/trimmed; limit clamped to `[1,100]` default 20; offset `>=0` default 0; invalid dates ignored vs. valid ISO parsed; filter passthrough.
- **Integration (real Postgres), the #7 acceptance matrix:**
  1. **Finds a readable message.** Owner posts "the deploy pipeline is green" in a channel; `GET …/search/messages?q=deploy` as a member → the message is in `results`, with a `rank`.
  2. **No leakage — non-member.** A second workspace member who is **not** in that channel runs the _same_ query → `results` is `[]`.
  3. **No leakage — cross-workspace.** A caller in a different workspace runs the same query → `[]` (and `wid` mismatch → 403).
  4. **Ranking + pagination.** Multiple matching messages come back ordered by rank/recency; `limit`/`offset` page through them without overlap.
  5. **Filters narrow.** `authorMemberId`, `channelId`, `after`/`before`, `threadId` each shrink the set to the expected rows; a `channelId` the caller can't read yields `[]` (no 403 oracle).
  6. **Index correct across edits/deletes.** Post a message matching `q`; soft-delete it → no longer found. Post matching `q1`; (when edit endpoint exists) editing body to `q2` flips which query matches — covered at the repo level by updating `body` directly and re-querying.
  7. **Channels & members.** Channel-name search returns only the caller's channels; member search returns workspace members; neither leaks across workspaces.
- Reuses the existing `integration` CI job (migrate → `test:integration` → prove down/up clean). The #4/#9 suites must stay green unchanged.

## Boundaries

- **Always:** authenticate every endpoint (#3); apply `assertWorkspace` (#19 IDOR); restrict every message/channel query to the caller's readable channel set via the membership sub-select; parameterize all SQL (no interpolation, including ILIKE patterns); keep the access decision identical to `GET messages` read; write the failing test first; keep routes thin; ship the additive migration with a clean paired down; attach a demo video.
- **Ask first:** adding a "discover public channels you're not in" mode (broadens scope beyond "what you can read"); returning 403/404 for an unreadable `channelId` filter (existence oracle trade-off); switching FTS language/config or to trigram/fuzzy matching; adding snippets/highlighting.
- **Never:** return a message from a channel the caller isn't a member of, under any filter or pagination value; build scoping as a post-query JS filter (must be a SQL predicate so pagination counts are correct); interpolate `q`/filters into SQL; let an unreadable `channelId` filter confirm the channel's existence via a distinct error; churn the #4 message/channel routes.

## Success criteria

1. Acceptance matrix (1–7 above) green in the `integration` job against real Postgres — especially the **no-leakage** cases (2, 3).
2. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass from `platform/`.
3. `0003_search` applies and reverses cleanly (CI down/up step green); #4 and #9 tests unchanged and green.
4. Channel-level scoping is a single SQL predicate reused by every search query; no per-row access calls, no JS-side filtering of results.
5. ADR-0007 records the FTS-as-generated-column + scoping-as-predicate decisions; demo `platform/docs/demos/07-search.mp4` walks the acceptance matrix (find → no leakage → filters).

## Open questions (defaults chosen; override before/at review if any are wrong)

1. **FTS via generated `tsvector` STORED column + GIN**, `websearch_to_tsquery('english', q)`, ranked by `ts_rank`. (Alternative: query-time `to_tsvector` or `ILIKE` on body — rejected for perf/ranking.) OK?
2. **Readable set = channel membership** (the projection of `effectiveCapability ≥ read` today), as a SQL sub-select. OK?
3. **Search is "what you can already read"** — no discovery of channels you're not in; members search is workspace-wide. OK?
4. **Unreadable `channelId` filter → empty results, not 403/404** (no existence oracle). OK?
5. **Offset pagination**, `limit` clamped to `[1,100]` (default 20). OK?

Defaults are pre-approved per the issue's detailed scope ("Postgres ILIKE or tsvector; new routes/search module; additive migration with paired down; permission-scoped, no leakage; no new dependency"). Proceeding DEFINE → PLAN → BUILD (TDD) → demo → PR (no merge without @gagan114662's approval).
