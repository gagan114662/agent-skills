# Spec: Reload Platform — Core Data Model & Migrations (Issue #2)

> Implements [#2](https://github.com/gagan114662/agent-skills/issues/2). Phase 0 — Foundation. Depends on #1.
> Lifecycle: this is the **DEFINE** artifact (`spec-driven-development`). No code until approved.

## Objective

**What:** Define the core relational schema, migrations (up **and** down), a typed repository layer, and a seed script — the persistence foundation every later feature (#4 channels, #6 threads, #9 permissions, #14 tasks, #15 memory graph) reads and writes.

**Why:** #1 only proved DB *connectivity*. This issue gives us *structure*: the multi-tenant tables and typed access functions. Getting the shape right here (tenancy, the human/agent "member" abstraction, threading, FKs) avoids painful migrations later, since #4–#17 all build on these tables.

**Who:** The implementers of #3–#17; every feature query goes through the repository layer defined here.

### Acceptance criteria (from #2, reframed as testable conditions)
- `pnpm db:migrate` applies the schema to a fresh Postgres; `pnpm db:rollback` reverts it cleanly; CI proves **up → down → up** with no errors.
- ER diagram committed at `platform/docs/data-model.md`.
- Seed script (`pnpm db:seed`) creates a demo workspace with 1 human + 1 agent + 1 channel + a message.
- Typed repository functions exist and are covered by **integration tests against real Postgres** (new CI service-container job — closes the gap review-nit #2 flagged on #1).

### Out of scope (deferred)
- Any HTTP endpoint or business logic (#4+). This is schema + repositories + migrations only.
- Auth credentials / agent tokens (#3) — `users`/`agents` get structural columns now, **secrets/tokens land in #3**.
- Full columns/behavior for `tasks`, `memories`, `memory_edges`, `permissions` — created as **minimal stub tables with FKs**; their owning issues (#14, #15, #9) extend them via new migrations.
- Redis schema/usage (#5). This issue is Postgres-only (Redis stays a health check).

## Tech approach
- **Drizzle ORM** schema in `apps/server/src/db/schema/*.ts` (one file per table group) — source of truth for the ORM.
- **Migrations are explicit SQL** in `apps/server/drizzle/`: hand-authored `NNNN_*.sql` (up) + `NNNN_*.down.sql` (down), applied by a tiny runner (`src/db/migrate.ts`) so `up`/`down`/`reset` are one command each. (We author SQL directly because `drizzle-kit generate` doesn't resolve our NodeNext `.js` specifiers; integration tests catch any schema↔SQL drift. See ADR-0002.)
- **Repository layer:** `apps/server/src/db/repositories/*.ts` — typed functions, the only sanctioned way features touch tables.
- Shared row types surfaced through `@reload/shared` where the web/CLI need them.

## Schema (proposed)

Multi-tenant: every table except global `users` carries `workspace_id` and cascades on workspace delete. PKs are UUID (see Open Question 2). All timestamps `timestamptz default now()`.

```
workspaces        id, slug (unique), name, created_at
users             id, email (unique), display_name, created_at          # global human identity (auth cols in #3)
agents            id, workspace_id→workspaces, owner_user_id→users,
                  name, framework, created_at                            # agent profile (tokens in #3)
members           id, workspace_id→workspaces, kind('human'|'agent'),
                  user_id→users (nullable), agent_id→agents (nullable),
                  display_name, created_at
                  # CHECK: kind='human' ⇒ user_id set & agent_id null; kind='agent' ⇒ vice-versa
                  # the per-workspace participant; channels/messages/tasks reference members, not users/agents

channels          id, workspace_id→workspaces, kind('public'|'dm'),
                  name (nullable for dm), is_archived, created_at        # unified; DMs are kind='dm' (Open Q1)
channel_members   channel_id→channels, member_id→members, joined_at
                  # PK (channel_id, member_id)
messages          id, workspace_id, channel_id→channels,
                  author_member_id→members, parent_message_id→messages (nullable, thread),
                  body (text), created_at, edited_at (nullable), deleted_at (nullable)
                  # indexes: (channel_id, created_at), (parent_message_id)

-- stub tables (FKs + minimal cols now; owning issue fills them out) --
tasks             id, workspace_id, title, status, assignee_member_id (nullable),
                  created_by_member_id, created_at                        # full system in #14
memories          id, workspace_id, type, content (jsonb), created_at     # typed graph in #15
memory_edges      id, workspace_id, from_memory_id→memories, to_memory_id→memories,
                  relation, created_at                                    # in #15
permissions       id, workspace_id, member_id→members, resource_type,
                  resource_id (nullable), capability('read'|'write'|'propagate')  # RBAC in #9
```

The full ER diagram (Mermaid) lands in `platform/docs/data-model.md` during BUILD.

## Commands (added by this issue)
```bash
pnpm db:migrate     # apply pending up migrations
pnpm db:rollback    # revert the last migration (runs its .down.sql)
pnpm db:reset       # drop + re-migrate (local convenience)
pnpm db:seed        # insert the demo workspace
pnpm test           # now includes db integration tests (real Postgres)
```

## Project structure (added)
```
apps/server/
  drizzle/                      → generated up migrations + hand-written *.down.sql
  src/db/
    schema/                     → workspaces.ts, members.ts, channels.ts, messages.ts, stubs.ts
    repositories/               → workspaces.ts, members.ts, channels.ts, messages.ts
    migrate.ts                  → up/down/reset runner
    seed.ts                     → demo workspace
  test/db/                      → integration tests (repositories + migrations)
platform/docs/data-model.md     → ER diagram
```

## Code style (example repository fn)
```ts
// apps/server/src/db/repositories/channels.ts
import { db } from "../index.js";
import { channels, channelMembers } from "../schema/channels.js";

export async function createChannel(input: {
  workspaceId: string;
  kind: "public" | "dm";
  name?: string;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(channels)
    .values({ workspaceId: input.workspaceId, kind: input.kind, name: input.name ?? null })
    .returning({ id: channels.id });
  return row;
}
```
Strict TS, named exports, snake_case columns ↔ camelCase fields via Drizzle, no raw SQL in feature code (only in migrations).

## Testing strategy
- **Integration over a real Postgres** (the point of this issue). Each test run migrates a fresh `reload_test` database; each test wraps its work in a transaction that **rolls back** for isolation.
- **CI:** new `integration` job (or extend `quality`) with **Postgres + Redis service containers** → runs `db:migrate`, the repository integration tests, then `db:rollback` to assert down migrations are clean. This is the service-container job the #1 review said was missing.
- Hermetic unit tests (#1 style) remain for pure logic.

## Boundaries
- **Always:** every non-`users` table has `workspace_id` with a cascading FK; features touch the DB only through the repository layer; write the failing integration test before the schema/repo; pair every up migration with a `.down.sql`; attach a demo video to the PR.
- **Ask first:** changing PK/id strategy after this lands; adding columns to a *stub* table that belong to its owning issue (do it in that issue); introducing a second migration tool.
- **Never:** put secrets/tokens in this issue (that's #3); cross-tenant queries without a `workspace_id` filter; destructive migration without a tested `.down.sql`; merge without Gagan's approval + video.

## Success criteria
1. Fresh Postgres + `pnpm db:migrate` → all tables created; `\dt` shows them.
2. `pnpm db:seed` → demo workspace with 1 human member, 1 agent member, 1 channel, 1 message.
3. A repository round-trip test (create workspace → member → channel → post message → read it back) passes against real Postgres.
4. `pnpm db:rollback` reverts cleanly; CI proves up → down → up.
5. ER diagram in `platform/docs/data-model.md`.
6. New service-container CI job green; `pnpm test` includes the integration tests.
7. **Video proof** at `platform/docs/demos/02-data-model.mp4` (migrate → seed → round-trip query → rollback), + CI artifact.
8. ADR-0002 records the id strategy + channels-unification + down-migration decisions.

## Open Questions (need your input before PLAN)
1. **Channels: unified `channels(kind)` vs separate `channels` + `dm_channels`.** The issue listed them separately, but I recommend **one `channels` table with `kind` ('public'|'dm')** — simpler, and `messages` always point at one `channel_id` (this is how Slack/Discord model it). OK to unify?
2. **Primary keys.** I recommend **UUIDv7** (app-generated, time-sortable — good for distributed agents and index locality) over DB `gen_random_uuid()` (v4, random). Agree, or prefer v4 / bigint?
3. **Down migrations.** Worth the cost? I recommend **yes** (paired `.down.sql` + runner) to satisfy "up/down clean in CI" and make rollbacks real. Alternative: forward-only + `db:reset`. Your call.
4. **Soft vs hard delete.** I recommend **soft-delete on `messages`** (`deleted_at`) since chat needs edit/delete history, hard delete elsewhere for now. OK?
5. **Member model.** OK with `members` as the per-workspace participant (humans link to global `users`, agents to workspace `agents`), with channels/messages/tasks referencing `member_id`? This is the key abstraction that makes "agents are first-class members" work.

Reply with approval (+ any overrides), or say **"use defaults and go"** and I'll proceed with all five recommendations into PLAN → TASKS → BUILD (TDD) → video → PR.
