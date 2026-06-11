# RESTORE runbook (disaster recovery)

> Issue [#99](https://github.com/gagan114662/agent-skills/issues/99) · [ADR-0099](../adrs/0099-disaster-recovery.md) · [Spec 43](../specs/43-disaster-recovery.md)
>
> **A backup you have never restored is just a hope.** This runbook is rehearsed continuously by the
> scheduled VALIDATION drill (`.github/workflows/dr-drill.yml`). The destructive DISASTER path is a
> lever a **human** pulls — it is **never agent-initiated**.

> **What "the live DB" means in production (#108).** Production runs on **Fly managed Postgres** (app
> `reload-api`); its connection string is the `DATABASE_URL` Fly secret. The off-site backup
> (`.github/workflows/dr-backup.yml`) dumps **that** database — its `DR_DATABASE_URL` repo secret MUST
> be set to the same connection string as the Fly `DATABASE_URL` (read it with `fly secrets list --app
> reload-api`, or `fly postgres connect`). In DISASTER mode, `$DATABASE_URL` below is the Fly production
> database, so the restore overwrites the live company. Flip the [maintenance flag](#3--maintenance-on)
> first.

There are two modes. **Default to VALIDATION.** Only escalate to DISASTER for a real data-loss event,
and only with an approved `dr.restore` human approval (#13).

| | VALIDATION (default) | DISASTER |
|---|---|---|
| Destructive? | No — restores into a **throwaway** DB | Yes — overwrites the live DB |
| Approval | none | **explicit #13 `dr.restore` approval, human-decided** |
| Who runs it | agent or human, any time | a **human**, never an agent |
| Outcome | a verify report | the portfolio is back online |

---

## VALIDATION mode (non-destructive — run it often)

Goal: prove the latest dump actually restores and is internally sound, without touching production.

```bash
# Restores the latest dump into a fresh throwaway DB and verifies counts + schema + freshness +
# content checksums against the live source. Exits non-zero (loud) on any failure.
pnpm --filter @reload/server dr:drill
```

This is exactly what the CI cron runs on a schedule. It is safe to run by hand any time. It never
writes to production and drops the throwaway DB when done.

---

## DISASTER mode (destructive — human-only, gated)

> **STOP.** This overwrites the live database. Do not start unless data loss is confirmed and you hold
> an **approved** `dr.restore` approval (#13). An agent must never initiate this path — `guardDisaster`
> and the #13 gate (`dr.restore` is sensitive-by-default) enforce it in code.

Follow the order **exactly**. The hard gates are not optional.

### 0 — Triage
Confirm this is real data loss (bad migration, errant `DELETE/DROP`, corruption) and not an app bug or
an outage that a rollback ([deploy `rollback`](../adrs/0041-deploy-to-live-url.md)) would fix. If a
deploy rollback fixes it, **do not restore the database.**

### 1 — Get the #13 approval
A human requests and **a different human approves** a `dr.restore` gate. No approval ⇒ stop here.

### 2 — Pre-flight (abort with NO outage)
Check creds + that a recent, non-empty dump exists **before** flipping maintenance:

- object-store credentials present,
- latest dump present and non-zero bytes,
- latest dump not older than the freshness bound (`DR_MAX_DUMP_AGE_MS`, default 24h).

`preflight()` encodes this. **If pre-flight aborts, nothing has changed — there is no outage.** Fix
the gap (creds / missing dump) and restart from step 2.

### 3 — Maintenance ON
```bash
reload maintenance on "DR restore in progress"   # instant, no redeploy; writes now 503, reads flow
```
Web + API reject writes; the autonomy/cron/deploy loops pause on the same flag. (The flag lives in
Redis, **not** Postgres — deliberately, so you can flip it while Postgres is unhealthy.)

### 4 — Snapshot the current state FIRST
Before overwriting anything, dump the **current** (damaged) DB to a safe location — this is your
undo. **Never delete this safety snapshot during the run**, even on success.
```bash
pg_dump --no-owner --no-privileges --format=plain "$DATABASE_URL" | gzip > safety-$(date -u +%Y%m%dT%H%M%SZ).sql.gz
```

### 5 — Restore
Restore the chosen good dump into the live DB.
```bash
gunzip -c <good-dump>.sql.gz | psql -v ON_ERROR_STOP=1 "$DATABASE_URL"
```
For **managed Postgres (Neon)** prefer provider **PITR / branching** over the dump here — see
[PITR path](#pitr-path-managed-postgres) below; the dump remains the off-site 3-2-1 copy.

### 6 — Verify (HARD GATE)
Run the verification suite (counts + schema + freshness + content checksums) against the restored DB.

> **HARD GATE: if verification FAILS, leave maintenance ON and STOP.** Do not lift maintenance over a
> half-restored database. Investigate (try a different dump, or restore the safety snapshot from step
> 4) and re-verify. A failed verify never reaches step 7.

### 7 — Maintenance OFF (only after a clean verify)
```bash
reload maintenance off
```
Writes resume; the loops un-pause.

### 8 — Report
Record: which dump, the safety-snapshot location, verify results, downtime (RTO), and the approval id.

---

## PITR path (managed Postgres)

When running **managed Postgres**, point-in-time recovery is the primary low-RPO tool and the dump is
the vendor-independent off-site copy (3-2-1):

- **Neon (preferred):** restore to a timestamp by **branching** from history
  (`neonctl branches create --parent <branch> --timestamp <ts>`), verify the branch, then repoint
  `DATABASE_URL`. Branching is near-instant and non-destructive (the original branch is untouched until
  you cut over) — it slots into step 5 above in place of the dump restore.
- **Vercel Postgres / other managed:** use the provider's PITR/restore console to a new instance, then
  repoint `DATABASE_URL`.

**Local / docker-compose has no PITR** — it is **dump-only**, stated honestly. There, RPO is the dump
cadence (the backup cron) and the only restore path is the gzipped `pg_dump` above.

## RPO / RTO

See the **Disaster recovery** section of [platform/README.md](../../README.md) for the stated **and
measured** RPO/RTO targets (the backup workflow logs the measured dump time; the drill logs the
restore time).
