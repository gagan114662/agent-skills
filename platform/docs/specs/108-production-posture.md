# Spec: Production Posture — close the remaining gaps so the company survives the laptop closing (Issue #108)

> Implements the **remaining deltas** of [#108](https://github.com/gagan114662/agent-skills/issues/108).
> Premortem #9: the platform, Postgres, Redis, and every venture lived on one laptop + a Hobby Vercel
> team — close the lid and the whole company sleeps. **Most of #108 already shipped** (see the audit
> below); this slice closes only what is left. Lifecycle: **DEFINE** artifact → atomic plan → TDD
> failing-first → ADR → one PR. **Video gate waived by the owner.**

## Audit — what already shipped (do NOT duplicate)

The hosting migration is **done and live**. Verified from the repo + the issue thread:

| Scope item from #108 | Status | Where |
|---|---|---|
| Hosted always-on API runtime | **DONE** — Fly app `reload-api`, always-on (`min_machines_running=1`, no auto-stop), `/readyz` traffic gate, migrate-on-deploy via `docker-entrypoint.sh` | `platform/fly.toml` |
| Managed Postgres | **DONE** — Fly managed Postgres, `DATABASE_URL` via `fly secrets` | issue thread; `fly.toml` |
| Managed Redis | **DONE** — Upstash Redis, `REDIS_URL` via `fly secrets` | issue thread |
| Hosted web URL (no 404) | **DONE** — Vercel project root `platform/apps/web`, `ipop.ai` / `www.ipop.ai`; API at `api.ipop.ai` with the CORS allowlist | `fly.toml` `RELOAD_WEB_ORIGIN`; [ipop-deploy guide](../../../docs/guides/ipop-deploy.md) |
| dev vs prod posture (#69 profiles) | **DONE** — `RELOAD_PROFILE=prod` on Fly; preflight/doctor gate launches | [cloud-setup](../guides/cloud-setup.md), [ADR-0038](../adrs/0038-cloud-default-posture.md) |
| Off-site DB backups | **DONE** — hourly `pg_dump → gzip → S3-compatible` (#99) + daily restore drill | `.github/workflows/dr-backup.yml`, `dr-drill.yml` |
| Restore runbook | **DONE** — VALIDATION + human-gated DISASTER modes | [restore-runbook](../playbooks/restore-runbook.md) |
| Infra budget ceiling (code) | **DONE** — `infraBudgetStatus` read-only signal in the Founder Console, tagged `#108` | `apps/server/src/scale/forecast.ts` (#113) |

## The remaining gaps (this slice)

Three concrete gaps survive the audit. Each is small and additive — **no migration, no new mutations,
no schema.**

### 1. Uptime monitoring + alerting on `api.ipop.ai` and `ipop.ai` (the only real new code)

There is no external watch on the two public URLs. Fly's own `/readyz` check restarts a *single
machine*, but nothing notices when **the whole site is down** (bad deploy, expired cert, DNS, Vercel
outage, dead Postgres) and tells a human. A 24/7 company needs a heartbeat that pages itself.

**What:** a scheduled GitHub Actions workflow (`uptime-check.yml`, every 5 min + `workflow_dispatch`)
that probes both URLs and, on failure, **opens a GitHub issue** (and comments + closes it on recovery)
— GitHub Issues *are* the notification surface (they fan out to the owner's existing notifications and
the Founder Console's issue feed). The judgment is a **pure core** so it is unit-tested without network
or the GitHub API:

- `evaluateResponse(probe, target) → { ok, detail }` — a target is healthy when the HTTP status is in
  the expected set **and** (optionally) the body contains an expected marker (`"ready"` for
  `/readyz`). A timeout / network error / wrong status / missing marker is **down**, with a redacted,
  human-readable `detail`.
- `decideAlertAction(target, probe, openIssue) → { action: "open" | "recover" | "noop", … }` — the
  **dedupe brain**: down + no open issue → `open` (one issue, once); down + an open issue already →
  `noop` (never spam every 5 min); up + an open issue → `recover` (comment "back up", close); up + no
  issue → `noop`. An issue is matched to its target by a **stable hidden marker** in the body
  (`<!-- uptime-monitor:<id> -->`) plus an `uptime-alert` label, so the dedupe survives title edits.
- `alertIssueTitle(target)` / `alertIssueBody(target, probe)` / `recoveryComment(probe)` — pure
  builders; the body carries the marker, the failing detail, and the runbook link.

The IO orchestrator (`check-cli.ts`) only gathers inputs (fetch each URL) and applies effects (list
open `uptime-alert` issues, create/comment/close). It is **fail-soft and self-guarding**: with no
`GITHUB_TOKEN` (a fork, or a local run) it prints the verdict and **exits non-zero if anything is
down** — so the workflow itself goes red even when it cannot open an issue. Provider plumbing reuses
the existing `GitHubIssueProvider` (#57/#117), extended with the two additive reads/writes it lacks
(`listOpenIssuesByLabel`, `closeIssue`).

### 2. DR backup: prove + document that it targets the **Fly** Postgres

`dr-backup.yml` already dumps off-site, but it dumps whatever `DR_DATABASE_URL` points at. Nothing in
the repo says *that secret must be the Fly production database*, and the restore path doesn't name the
live target. Gap = **documentation + an operator checklist**, not code: the backup brief gets a
"production target" section that says `DR_DATABASE_URL` = the same connection string as the Fly
`DATABASE_URL` secret (read it with `fly secrets list`/`fly postgres connect`), and the restore runbook
gains a "this is the live Fly DB" pointer so a 2 a.m. operator restores into the right place.

### 3. Monthly cost ceiling: runbook + guardrails

The infra *budget-ceiling signal* exists in code (#113 `infraBudgetStatus`), but there is **no operator
runbook** tying it to the actual hosting bill, and the two hard caps that already exist are undocumented.
Gap = a **cost-ceiling runbook** (`playbooks/cost-ceiling.md`) that records:

- the **hard caps already in place**: Fly is pinned to exactly **one** `shared-cpu-1x` / 512 MB machine
  (`min_machines_running=1`, `auto_start_machines=false`) — it *cannot* horizontally surprise-bill;
- the **soft signal**: `scale.infraBudgetCeilingCents` → `infraBudgetStatus` → the Founder Console
  warns **before** projected spend crosses the monthly ceiling;
- the **external guardrail**: set a Fly organization **spend limit** / billing alert (vendor-side hard
  stop), with the exact `fly` commands and the alarm-response steps (who looks, what to scale down).

## The pure cores (the testable gates)

Consistent with #17 `decideWorkflowAction`, #96 `decideVenture`, #105 `decideRevival`, #113
`infraBudgetStatus`: the judgment is pure and fully unit-tested; the IO orchestrator only gathers inputs
and applies effects.

- `evaluateResponse`, `decideAlertAction`, `alertIssueTitle`/`alertIssueBody`/`recoveryComment`,
  `parseTargets` (`apps/server/src/uptime/check.ts`) — health verdict + dedupe brain + issue rendering +
  config parsing. Covered by `test/unit/uptime-check.test.ts`.

## Non-goals / out of scope

- **No migration, no new tables, no new mutations.** The uptime monitor stores its state *in GitHub
  Issues* (the open issue IS the "currently alerting" flag), exactly so it needs no DB.
- Not re-doing the hosting migration, the DR pipeline, or the cost-forecast code — all shipped.
- Not a full APM/Pingdom integration — the brief asks for "external check or scheduled workflow that
  opens a GitHub issue on failure," which is precisely the cheapest thing that survives the laptop
  closing (it runs on GitHub's infra, not ours).

## Verification

- `pnpm --filter @reload/server test:unit` — the new `uptime-check` unit suite is green (TDD: each
  decision branch failed first).
- `pnpm --filter @reload/server typecheck` — clean.
- `node --check` / a YAML lint of `uptime-check.yml`; a `workflow_dispatch` dry-run against the live
  URLs (report-only, no token) prints both as healthy.
- The cost-ceiling + DR-target docs are cross-linked from `operations.md` and the restore runbook.
