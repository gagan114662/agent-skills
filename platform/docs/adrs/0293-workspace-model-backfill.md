# ADR-0293: Idempotent backfill for per-workspace fleet-model overrides that migration 0246 missed

- **Status:** Accepted (shipped in PR for #293) — build + dry-run only; the prod write is owner-gated.
- **Date:** 2026-06-18
- **Context issue:** [#293](https://github.com/gagan114662/agent-skills/issues/293) — PROD DATA: the #seo
  workspace (and likely others) is still pinned to an unservable model (`claude-fable-5`), so every
  `claude -p --model claude-fable-5` session 403s and exits 1 → the owner sees *"the model this workspace
  is set to use isn't available"*. Migration 0246 was supposed to fix this but didn't cover the live rows.
- **Builds on:** [ADR-0099](0099-disaster-recovery.md) (migrations numbered by issue to dodge
  sibling-branch prefix collisions), the `claude-opus-4-8` fleet model + launch preflight
  ([#246](https://github.com/gagan114662/agent-skills/issues/246), `runtime/models.ts`), the
  `verify-release-cli.ts` dry-run+receipts CLI shape ([ADR-0292](0292-release-version-verification.md)),
  and [ADR-0200](0200-premortem-panel.md) (the standing premortem — FM#2 self-reported metrics are
  fiction, FM#3 verification must touch reality, FM#4 irreversibility classes).
- **Pairs with:** [#292](https://github.com/gagan114662/agent-skills/issues/292) (deploy didn't advance →
  the code fix never reached prod) and overlaps the model-config area of
  [#261](https://github.com/gagan114662/agent-skills/issues/261) (remove model config from the UX) — see
  *Overlap with #261* below.

## Context

[Migration 0246](../../apps/server/drizzle/0246_fleet_model_opus.sql) added the per-workspace
`workspace_agent_credentials.model` override column and rewrote the one live-confirmed bad id:

```sql
UPDATE workspace_agent_credentials SET model = 'claude-opus-4-8' WHERE model = 'claude-fable-5';
```

That left two gaps that keep a live workspace stuck:

1. **Exact-match only.** It matched the literal string `claude-fable-5`. Any *other* unservable id (a
   typo, a different retired model, a blank string) survives untouched.
2. **It never re-ran on prod.** The migration runner (`db/migrate.ts`) tracks applied migrations by
   **filename** in `_migrations`. Once `0246_fleet_model_opus.sql` was recorded, `db:migrate` reported
   "nothing pending" — so even after the codebase default was corrected, the *data* in the already-migrated
   prod database stayed bad. (This is exactly the "did not run against prod or did not cover existing rows"
   the issue describes.)

The runtime boundary already self-heals a bad value at spawn time (`resolveLaunchModel` falls back to the
managed default), and the save path already rejects an unservable pick (the `/me/agent-model` route 400s).
But the **stored** value is still wrong, so the owner still sees the scary "model isn't available" wording,
and any code path that reads the raw override (or a future regression in the self-heal) is still exposed.
The durable fix is to repair the data.

## Decision

Repair the data idempotently, with a previewable + verifiable, owner-gated apply. Four parts:

1. **A new migration, [`0293_workspace_model_backfill.sql`](../../apps/server/drizzle/0293_workspace_model_backfill.sql).**
   A new filename forces it to run once on every already-migrated database (prod included). It
   *generalizes* 0246: rewrite **every** non-null override that is not in the servable set to the managed
   default `claude-opus-4-8`. A `NULL` override (meaning "use the deployment default") and an
   already-servable pick are left untouched, so the UPDATE is **idempotent and re-runnable** — after it
   runs, no row violates the predicate. Numbered `0293` by issue (ADR-0099); `0293` is unused on
   `origin/main`. It sorts before the already-applied `0294`/`0295` but is independent of them (it only
   needs the `model` column 0246 added), so running out of numeric order is safe (see `drizzle/README.md`).

2. **A pure decision, [`runtime/model-backfill.ts`](../../apps/server/src/runtime/model-backfill.ts).**
   `planModelBackfill(rows, env)` is the single source of truth for "which rows need repair" — total, no
   IO, idempotent. It reuses `isKnownModel`/`DEFAULT_AGENT_MODEL` from `runtime/models.ts`, so the SQL and
   the code share one definition of "servable". An anti-drift unit test pins the migration's `NOT IN (…)`
   list to `KNOWN_AGENT_MODELS` so they can't diverge.

3. **An owner-gated CLI, [`runtime/model-backfill-cli.ts`](../../apps/server/src/runtime/model-backfill-cli.ts)**
   (`pnpm --filter @reload/server model:backfill`). **Dry-run by default**: it prints the exact rows it
   would change and exits 0 without writing. It writes only when armed with `MODEL_BACKFILL_APPLY=1`, and
   after writing it **reads the rows back from the real DB and re-plans, asserting zero remain** — a
   production-grounded receipt (#200 §2/§3), never an assumption. A row still unservable after apply fails
   the run closed (exit non-zero).

4. **A persistence-boundary guard (#293, defense in depth).** `setWorkspaceClaudeModel` now calls
   `assertModelLaunchable` for any non-null model, so "a workspace saved pinned to an unavailable model" is
   unrepresentable regardless of which caller writes it — the HTTP route's 400 stays the first line of
   defense; this is the second.

## Why owner-gated, and why I did not run it

This is an **IRREVERSIBLE prod data write** (#200 §4): it overwrites the stored override and the original
value is not recoverable (no audit column). It is acceptable *because the only values it touches are
unservable ids that crash every session* — there is no legitimate value being destroyed (the same stance
0246's down takes). Even so, per the premortem and the issue, the actual prod run stays owner-gated. This
PR ships the build, the tests, and a dry-run capability; **the prod write was not executed.** The owner
runs the dry-run to review the exact rows, then either (a) merges + deploys (the migration runs in the Fly
`release_command`, #273) or (b) runs `MODEL_BACKFILL_APPLY=1 pnpm … model:backfill` and reads back the
receipts. Both repair the same rows to the same target.

## Rollback

Documented in [`0293_workspace_model_backfill.down.sql`](../../apps/server/drizzle/0293_workspace_model_backfill.down.sql):
the down is a deliberate **no-op**. Reverting a data repair would mean restoring ids that crash every
session — a regression, not a rollback — and the original values are not recoverable from this migration.
Operational rollback, if ever required, is at the schema layer (0246's down drops the `model` column,
dropping every override so all workspaces fall back to the deployment default), not here.

## Overlap with #261 (remove model configuration from the UX)

Both touch the model-config area. They are complementary, not conflicting:

- **#261** removes the *forward-facing* footgun: a non-technical user should never see a model picker, and
  the runtime must never spawn with an empty/unservable model. That work lives in the UX + the runtime
  boundary (`resolveLaunchModel`, the managed default).
- **#293 (this ADR)** cleans up *existing data* that predates the managed default — workspaces already
  pinned to an unservable id — and adds the persistence-boundary guard so new bad data can't be written.

The guard added here (`setWorkspaceClaudeModel` → `assertModelLaunchable`) reinforces #261's invariant at
the database layer. If #261 later removes the per-workspace override entirely, this backfill remains a safe
no-op (zero rows match the predicate) and the migration ledger is undisturbed.

## Consequences

- The data root cause of #293 is fixed durably and idempotently; the repair is safe to re-run.
- A workspace can no longer be *saved* pinned to an unavailable model (route 400 + repo guard).
- The owner gets a dry-run preview and a read-back receipt for an irreversible write, honoring #200.
- The SQL allowlist and the code's `KNOWN_AGENT_MODELS` are kept in lockstep by an anti-drift test; adding
  a servable model in code without updating the migration fails CI.
