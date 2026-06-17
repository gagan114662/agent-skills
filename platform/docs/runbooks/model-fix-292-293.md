# Runbook — ship the #246 model fix to prod + backfill (#292 stale deploy, #293 model backfill)

> Owner-executed. Read-only diagnosis already done; nothing in prod was changed by the prep.
> Rollback target captured below. Redeploy only — no secret/credential changes, no destructive DB ops.

## State at prep time (2026-06-16)
- **Current release (ROLLBACK TARGET): `v84`** — image `registry.fly.io/reload-api:deployment-01KV936G2F7JW1GJ8XB62118BS` (machine `85596dc5094018`, region `yyz`, 1/1 checks passing, `/readyz` 200).
- Releases are churning fast (v80→v84 within hours via the #278 self-managed pipeline) — relevant to **#292**.
- DB (read-only): `workspace_agent_credentials.model` for the #seo workspace `019eb395…` = `claude-opus-4-8`; **0** workspaces and **0** personas pinned to an unavailable model; **0** open self-healing incidents; last 6 sessions all `completed exit 0`. The **#293 backfill dry-run changed 0 rows** — the per-workspace store is already clean.

## 1. Capture the rollback target (known-good)
```
fly releases -a reload-api
```
Note the current `complete` VERSION (v84) + image ref above.

## 2. Deploy latest origin/main (fixes #292 — get the merged image live)
Deploy from a CLEAN origin/main checkout (this Conductor worktree is the shared `deploy-main` tree and carries the #248 session's uncommitted WIP — do NOT `fly deploy` from it or that WIP gets baked in):
```
git fetch origin && git worktree add /tmp/reload-deploy origin/main && cd /tmp/reload-deploy/platform && fly deploy -a reload-api
```
The #278 `[deploy] release_command` runs migrations → preflight → smoke and health-gates the rolling cutover, so a bad image aborts before traffic shifts. Cleanup after: `git worktree remove /tmp/reload-deploy`.

## 3. Backfill per-workspace models (#293 — idempotent, currently a no-op)
The migration `apps/server/drizzle/0293_backfill_workspace_model.sql` (rewrites any non-NULL unavailable model → `claude-opus-4-8`; NULL untouched). If committed to main it auto-runs in step 2's release_command. To run it standalone (one command, from the clean checkout with `DATABASE_URL` pointed at prod via `fly proxy`):
```
cd /tmp/reload-deploy/platform/apps/server && pnpm db:migrate up
```
Dry-run already proved 0 rows change today; this is a safety net for any future bad pin.

## 4. Verify (model error gone)
```
fly status -a reload-api    # machine started, checks passing
```
Then kick one tiny task on the #seo workspace (console or @scout) and confirm the session reaches `completed exit 0` — no "the model this workspace is set to use isn't available".

## 5. Rollback (only if health checks fail or the model error persists)
```
fly deploy -a reload-api --image registry.fly.io/reload-api:deployment-01KV936G2F7JW1GJ8XB62118BS
```
(redeploys the captured v84 known-good image immediately).
