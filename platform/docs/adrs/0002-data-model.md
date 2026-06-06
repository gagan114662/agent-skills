# ADR-0002: Core data model decisions

- **Status:** Accepted (Gagan approved defaults — issue #2)
- **Date:** 2026-06-06
- **Context issue:** [#2](https://github.com/gagan114662/agent-skills/issues/2)
- **Builds on:** [ADR-0001](0001-stack.md)

## Context
#2 lays the relational foundation for Reload. Five design choices shape everything #3–#17 build on. All five were reviewed and approved as the recommended defaults.

## Decisions

1. **Unified `channels` table with a `kind` column (`'public' | 'dm'`)** rather than separate `channels` + `dm_channels`.
   - *Why:* messages always reference a single `channel_id`; DMs are just channels with `kind='dm'` and a member set. This is how Slack/Discord model conversations and avoids branching every message/membership query on channel type.

2. **Primary keys are UUIDv7** (application-generated, time-sortable) via the `uuidv7` package, stored in Postgres `uuid` columns.
   - *Why:* no coordination needed across distributed agents, globally unique, and time-ordered so they cluster in indexes (better locality than random v4) and sort chronologically for free.

3. **Real down-migrations, authored as explicit SQL.** Each migration is a hand-authored `drizzle/NNNN_*.sql` (up) paired with `drizzle/NNNN_*.down.sql` (down), applied by a small custom runner (`src/db/migrate.ts`) supporting `up` / `down` / `reset` and tracked in a `_migrations` table.
   - *Why:* satisfies the "up/down clean in CI" acceptance criterion and makes rollbacks a tested, first-class operation. We author SQL directly rather than via `drizzle-kit generate`, which fails to resolve our NodeNext `.js` import specifiers; explicit SQL is also fully reviewable. drizzle-kit remains available (config kept) for schema diffing/studio, and the Drizzle schema in `src/db/schema/` stays the source of truth for the ORM — the integration tests catch any schema↔SQL drift.

4. **Soft-delete on `messages`** (`deleted_at timestamptz`), hard-delete elsewhere (for now).
   - *Why:* chat needs edit/delete history and threads must survive a parent's deletion (tombstone). Other tables don't yet need it; revisit per feature.

5. **The `members` abstraction.** A `members` row is the per-workspace participant; it is either a human (`kind='human'`, `user_id` → global `users`) or an agent (`kind='agent'`, `agent_id` → workspace `agents`). Channels, messages, tasks reference `member_id`.
   - *Why:* this is what makes "agents are first-class members" structural rather than bolted-on — every participant-bearing relation treats humans and agents identically. A CHECK constraint enforces exactly-one-of `user_id`/`agent_id` consistent with `kind`.

## Consequences
- **Positive:** clean, tenant-scoped schema; participant interchangeability; tested rollbacks; sortable ids.
- **Costs/risks:** hand-written down files are manual effort per migration (accepted); `members` indirection adds one join to resolve a human's email/agent's profile (worth it for the abstraction); UUIDv7 via a dependency (small, vetted).
- **Forward links:** `users`/`agents` gain auth columns/tokens in **#3**; `tasks`/`memories`/`memory_edges`/`permissions` are minimal **stubs** here, extended by **#14/#15/#9**. A Postgres/Redis **service-container CI integration job** is added here (closes the gap flagged in the #1 review).
