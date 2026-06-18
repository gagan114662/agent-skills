-- #293 — backfill the per-workspace fleet-model override that migration 0246 missed.
--
-- 0246 added `workspace_agent_credentials.model` and rewrote the ONE live-confirmed bad id
-- (`UPDATE ... SET model='claude-opus-4-8' WHERE model='claude-fable-5'`). That left two gaps the
-- #seo workspace (and likely others) is still stuck in: (a) it only matched that EXACT string, so any
-- OTHER unservable id survives; and (b) the runner tracks applied migrations by filename, so once 0246
-- was in `_migrations` it never re-ran — `db:migrate` reported "nothing pending" while prod stayed bad.
--
-- This is a NEW filename, so it runs once on every already-migrated database (including prod), and it
-- generalizes the repair: rewrite EVERY non-null override that is not in the servable set to the managed
-- default `claude-opus-4-8`. Idempotent + re-runnable + forward-safe — a NULL override (use the
-- deployment default) and an already-servable pick are untouched, and after it runs no row violates the
-- predicate, so re-applying it changes nothing.
--
-- Numbered 0293 by ISSUE (ADR-0099 convention; 0293 is unused on origin/main) to dodge sibling-branch
-- prefix collisions. It sorts before the already-applied 0294/0295 but is independent of them (it only
-- needs the `model` column 0246 added), so running out of numeric order is safe (drizzle/README.md).
--
-- The servable list below MUST match KNOWN_AGENT_MODELS in src/runtime/models.ts — an anti-drift unit
-- test (model-backfill-migration.test.ts) pins them together so the SQL and the code can't diverge.
-- (The `RELOAD_KNOWN_MODELS` env escape hatch is intentionally NOT reflected here: SQL can't read it, and
-- this canonical-list repair is conservative — at worst it rewrites an env-allowed-but-uncurated id to the
-- always-servable default, never the reverse.)
--
-- IRREVERSIBLE prod data write (#200 §4): it overwrites the stored override. That is acceptable here
-- because the only values it touches are unservable ids that crash every session — there is no
-- legitimate value being destroyed (mirrors 0246's stance). The owner previews the exact rows first via
-- `pnpm --filter @reload/server model:backfill` (dry-run) and reads them back after (receipts).
UPDATE workspace_agent_credentials
   SET model = 'claude-opus-4-8', updated_at = now()
 WHERE model IS NOT NULL
   AND model NOT IN (
     'claude-opus-4-8',
     'claude-opus-4-7',
     'claude-opus-4-6',
     'claude-sonnet-4-6',
     'claude-sonnet-4-5',
     'claude-haiku-4-5',
     'claude-haiku-4-5-20251001'
   );
