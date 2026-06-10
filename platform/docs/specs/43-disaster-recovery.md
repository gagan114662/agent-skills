# Spec 43 — Agent-operated disaster recovery

- **Issue:** [#99](https://github.com/gagan114662/agent-skills/issues/99)
- **ADR:** [ADR-0099](../adrs/0099-disaster-recovery.md)
- **Status:** Implemented
- **Builds on:** #2 (data model / migrations), #13 (approval gates), #17 (autonomy loop),
  #19 (observability / health), #55 (cloud workspaces), #73 (deploy).

## Problem

Every venture in the portfolio shares **one** Postgres. Today it has **zero** backups: one bad
migration, one `DROP TABLE`, one fat-fingered `DELETE` kills the whole portfolio with no way back.
A backup you have never restored is just a hope. We need agent-operated disaster recovery built to
the **3-2-1 rule** (≥3 copies, ≥2 media, ≥1 off-site) with an explicit, *measured* RPO/RTO and a
restore path a human has actually rehearsed.

## Goals

1. **Off-site dump** — a scheduled job dumps Postgres, gzips it, and uploads it to
   **vendor-independent** object storage with **least-privilege** write creds, referenced by name,
   never logged.
2. **PITR path** — document point-in-time restore on managed Postgres (Neon branching preferred;
   works on Vercel/Neon), with an **honest** local/compose fallback (dump-only, stated as such).
3. **Instant maintenance mode** — a Redis-backed flag, checked **per request**, that makes web + API
   reject writes and pauses the autonomy/cron/deploy loops, flips in **seconds with no redeploy**,
   and **fails open** (a deliberate, documented choice). Plus a `reload maintenance on|off|status`
   CLI.
4. **RESTORE runbook** — a repo playbook with two modes:
   - **VALIDATION** (default, non-destructive): restore the latest dump into a throwaway DB and
     sanity-check it (row counts + schema + freshness + content checksums), then report.
   - **DISASTER** (destructive): requires **explicit #13 human approval**, is **never agent-initiated**.
5. **Scheduled VALIDATION drill** — a CI cron that restores the latest dump into a throwaway Postgres
   service container and runs the sanity suite, **failing loudly** — so corrupt dumps and dead creds
   are caught on a Tuesday, not at 2 a.m.
6. **RPO/RTO** — targets stated **and** measured, in a DR section of the platform README.

## Non-goals

- Continuous physical replication / streaming standby (PITR via the managed provider covers the
  low-RPO need where we run managed).
- A web UI for maintenance/restore (CLI + runbook only this slice, like #18's other gaps).
- Automatic failover. DISASTER restore is a lever a **human** pulls — by design.

## Design

### 1. Maintenance mode (Redis flag, per-request gate)

- **Flag** (`src/maintenance/flag.ts`): one global key in the Redis already in the stack
  (`reload:maintenance`), value a small JSON blob `{ since, reason, by }`. `getMaintenanceState()`
  reads it; `setMaintenance(on, meta)` writes/clears it. Both **fail open**: any Redis error returns
  `{ enabled: false, unavailable: true }` — an unreachable Redis must never lock the whole platform
  into read-only. This is the deliberate availability-over-consistency trade, documented in the ADR.
- **Policy** (`src/maintenance/policy.ts`, pure): `isWriteRequest(method)` (anything not
  `GET/HEAD/OPTIONS`), and `shouldRejectWrite(state, method, routePath)` — rejects writes when
  `state.enabled`, **unless** `unavailable` (fail-open) or the route is on the always-allow list (the
  maintenance control route itself, health/readiness probes, `/metrics`, auth). Pure ⇒ unit-tested
  with no Redis.
- **Gate** (`src/maintenance/gate.ts`): a root `onRequest` hook (installed directly on the app like
  `registerObservability`, so it covers every route plugin) that reads the state and replies `503`
  with `Retry-After` for a rejected write. Reads always pass.
- **Loops** pause: the autonomy engine checks `maintenancePaused()` at the top of `tickAll()` and
  skips the pass; the cloud idle-sweep loop checks it before sweeping. Same flag, instant effect.
- **Route + CLI**: `GET /maintenance` (status) and `POST /maintenance {on, reason}` (toggle),
  authenticated; `reload maintenance on|off|status` wraps them. The control route is on the gate's
  allow-list so you can always turn maintenance **off** while it is on.

### 2. Backup, object store, restore/verify

- **Object store seam** (`src/dr/object-store.ts`): an `ObjectStore` interface
  (`put`/`getLatest`/`list`) with a `LocalDirObjectStore` implementation (filesystem) — the default,
  no cloud spend, used by tests, the drill, and the honest local/compose fallback. Real off-site
  upload is done by the backup **workflow** with the `aws` CLI against an **S3-compatible,
  endpoint-configurable** bucket (Cloudflare R2, Backblaze B2, MinIO, AWS S3 …) ⇒ vendor-independent.
- **Dump/restore** (`src/dr/dump.ts`): thin wrappers around `pg_dump --format=plain | gzip` and
  `gunzip | psql`, plus `pgToolsAvailable()` so tests skip cleanly where the client tools are absent.
- **Verify** (`src/dr/verify.ts`): pure comparison helpers (`diffCounts`, `assessFreshness`,
  `checksumsMatch`) + `verifyRestore(client, expectations)` which checks **row counts**, **schema**
  (expected tables present), **freshness** (newest row not older than a bound), and **content
  checksums** (a stable md5 over ordered rows of anchor tables). Returns a structured report.

### 3. Runbook orchestration + #13 gate

- `src/approvals/policy.ts` gains `DR_RESTORE_ACTION = "dr.restore"`, added to
  `DEFAULT_SENSITIVE_ACTIONS` ⇒ a restore is **gated by default**: with no rule it requires approval,
  and there is no path for an agent to self-approve (only a human decides a #13 gate).
- `src/dr/runbook.ts` (mostly pure, deps injected):
  - `preflight(input)` — the abort-without-outage check: missing creds, missing/zero-byte dump, or a
    dump older than the freshness bound ⇒ `{ proceed: false, abort }` **before** any maintenance flip.
  - `guardDisaster(mode, approval)` — VALIDATION needs nothing; DISASTER throws `DisasterNotApproved`
    unless given an **approved** `dr.restore` #13 approval. Encodes "never agent-initiated".
  - `runValidationDrill(deps)` — download latest dump from the `ObjectStore`, restore into a
    throwaway DB, `verifyRestore`, drop the throwaway, return the report. Non-destructive.
  - The DISASTER ordering (documented in the runbook, enforced by `guardDisaster` + the gate): triage
    → preflight (abort with no outage) → maintenance **ON** → snapshot current state first → restore
    → verify → **only then** maintenance **OFF** → report. **Hard gate:** verification fails ⇒
    maintenance stays **ON** and we stop; the safety snapshot is never deleted in-run.

### 4. CI

- `.github/workflows/dr-backup.yml` — `schedule` (cron) + `workflow_dispatch`. `pg_dump | gzip`,
  timed (the measured RPO input), `aws s3 cp` to the bucket with least-privilege creds from repo
  secrets, referenced by name, never echoed. No-op with a notice when unconfigured (forks).
- `.github/workflows/dr-drill.yml` — `schedule` + `workflow_dispatch`. Boots a throwaway
  `postgres:16-alpine` service, installs `postgresql-client`, runs `pnpm --filter @reload/server
  dr:drill`: migrate + seed a source, dump it, restore into a throwaway, verify — **fails loudly**.
  When real bucket creds are present it additionally pulls and validates the latest **stored** dump
  (so dead creds / a corrupt off-site dump are caught too).

## RPO / RTO

| Metric | Target | Basis |
|--------|--------|-------|
| **RPO** (managed, Neon PITR) | ≤ 5 min | provider WAL retention |
| **RPO** (dump-only fallback) | ≤ backup interval (default **hourly** cron) | the dump cadence, not the cron string |
| **RTO** (VALIDATION drill) | minutes | measured by the drill each run |
| **RTO** (DISASTER restore) | ≤ 30 min for the shared DB | rehearsed via the runbook |

The README records the **measured** dump timing from the backup workflow, since the real RPO is the
dump duration + cadence, not the cron expression.

## Testing (TDD — tests written first)

**Unit (no DB/Redis):**
- `maintenance-policy.test.ts` — writes rejected when enabled; reads always allowed; control/health
  routes allow-listed; **fail-open** when the state is `unavailable`.
- `dr-runbook.test.ts` — `preflight` aborts on missing creds / missing dump / stale dump (no outage);
  `guardDisaster` lets VALIDATION through, throws for DISASTER without an approved `dr.restore`
  approval, accepts an approved one.
- `dr-verify.test.ts` — `diffCounts`, `assessFreshness`, `checksumsMatch` pure logic.
- `approval-policy.test.ts` — `dr.restore` is sensitive by default (requires approval with no rule).
- `autonomy-maintenance.test.ts` — `tickAll()` short-circuits when `maintenancePaused()` is true.

**Integration (real Postgres + Redis):**
- `dr-recovery.test.ts` — a write is `503`'d during maintenance while reads pass, and resumes when
  flipped off; and the end-to-end drill: seed → dump → put in a fake (LocalDir) bucket → restore into
  a throwaway DB → verify ⇒ report `ok` (skips cleanly where `pg_dump`/`psql` are unavailable).

## Demo

`scripts/demos/43-disaster-recovery.sh` — flip maintenance on (write → 503, read → 200), flip off
(write works), then run the VALIDATION drill against a fake bucket and print the verify report.
