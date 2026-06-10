# ADR-0099: Agent-operated disaster recovery

- **Status:** Accepted (shipped in PR for #99)
- **Date:** 2026-06-10
- **Context issue:** [#99](https://github.com/gagan114662/agent-skills/issues/99)
- **Spec:** [docs/specs/43-disaster-recovery.md](../specs/43-disaster-recovery.md)
- **Builds on:** [ADR-0002](0002-data-model.md) (migrations), [ADR-0013](0013-approval-gates.md)
  (human approval gates), [ADR-0017](0017-autonomy.md) (autonomy loop),
  [ADR-0019](0019-deploy-observability.md) (health/observability),
  [ADR-0041](0041-deploy-to-live-url.md) (deploy).

> **Numbering note.** The spec/demo use the `43` slot; this ADR is numbered `0049` (the next free ADR
> after `0048`), per the project's independent-ADR-numbering convention (see ADR-0048's note).

## Context

The whole portfolio shares one Postgres with **no** backups. A single bad migration or stray
`DELETE` is unrecoverable. The premortem finding is blunt: *a backup you have never restored is just
a hope*. We need disaster recovery that an agent can operate day-to-day but where the destructive
lever stays firmly in a human's hand — built to the 3-2-1 rule with a **measured** RPO/RTO, adapted
from ryancarson's June 10 DR playbook.

The hard parts are not "run `pg_dump`". They are: (a) making the off-site copy **vendor-independent**
and its creds **least-privilege + never logged**; (b) a maintenance switch that is **instant** (no
redeploy) and **safe when its own backing store is down**; (c) a restore path whose destructive mode
**cannot** be triggered by an agent and **cannot** silently leave the system half-restored.

## Decisions

1. **Maintenance is one Redis flag, read per-request, and it fails open.** The flag lives in the
   Redis already in the stack (no new infra). A pure policy (`shouldRejectWrite`) decides per request;
   a single root `onRequest` hook (installed directly on the app, like `registerObservability`, so it
   covers every route plugin — a `register`ed plugin would encapsulate its hook) enforces it. Writes
   (non-`GET/HEAD/OPTIONS`) get `503 + Retry-After`; reads always pass. **Fail-open is deliberate:**
   if Redis is unreachable the gate admits everything rather than locking the platform read-only.
   Rationale: maintenance mode is a *planned-safety* tool, not a security boundary; a Redis outage
   must degrade to "no maintenance gate", never to "total write outage". This trade is the single
   most important DR decision and is called out in the README and the flag's docstring.

2. **The maintenance control route is on the gate's allow-list.** Otherwise turning maintenance
   **off** would be a blocked write — you could never get out. Health/readiness probes, `/metrics`,
   and auth are allow-listed for the same reason (operability during maintenance).

3. **The loops pause on the same flag.** The autonomy engine checks an injected `maintenancePaused()`
   at the very top of `tickAll()` (before any DB call), and the cloud idle-sweep loop checks it before
   sweeping. No launcher/lister is called when paused. Default (no dep) = never paused, so existing
   #17 tests are unchanged.

4. **Off-site storage is an `ObjectStore` seam; the default is local, the real backend is the
   workflow's `aws` CLI against an S3-compatible endpoint.** Like the rest of the platform's
   dryrun-by-default convention, the TS code defaults to a `LocalDirObjectStore` (no spend; used by
   tests, the drill, and the honest local/compose fallback). The real off-site copy is uploaded by the
   backup GitHub Actions job using `aws s3 cp` with a **configurable endpoint URL** — so it works with
   Cloudflare R2, Backblaze B2, MinIO, or AWS S3 unchanged. Vendor independence comes from the
   S3-compatible protocol, not from a vendor SDK we bake in.

5. **Least-privilege creds by name, never logged.** The bucket creds are write-scoped repo secrets
   (the AGENT_SECRETS discipline: referenced by name, never echoed). The drill uses read-only creds.
   No step prints a secret value; the dump file name and byte size are the only artifacts logged.

6. **A restore is a #13-sensitive action; DISASTER mode is gated and never agent-initiated.**
   `dr.restore` is added to `DEFAULT_SENSITIVE_ACTIONS`, so with no rule it requires human approval —
   and a #13 gate can only be decided by a human (an agent can never approve its own gate, ADR-0013).
   `guardDisaster(mode, approval)` enforces this in code: VALIDATION needs nothing; DISASTER throws
   unless handed an **approved** `dr.restore` approval. VALIDATION is the default everywhere.

7. **Ordering and hard gates are enforced, not just documented.** DISASTER order: triage → preflight
   (abort with no outage) → maintenance ON → snapshot-current-state-first → restore → verify → only
   then maintenance OFF → report. `preflight()` aborts **before** any maintenance flip (no outage on a
   doomed run). **If verification fails, maintenance stays ON and we stop** — a half-restored DB is
   never exposed — and the safety snapshot is **never deleted in-run**.

8. **Verification is multi-dimensional.** `verifyRestore` checks row **counts**, **schema** (expected
   tables present), **freshness** (newest row within a bound), and **content checksums** (stable md5
   over ordered anchor-table rows). Counts alone catch truncation; checksums catch silent content
   corruption a count would miss.

9. **The drill runs on a schedule and fails loudly.** A CI cron restores into a throwaway Postgres
   service container and runs the sanity suite every run — catching corrupt dumps and dead creds on a
   Tuesday. The self-contained pipeline (seed → dump → restore → verify) always runs so the gate is
   meaningful even in a fork; when real bucket creds exist it also validates the latest stored dump.

## Consequences

- One Redis key, flipped via CLI in seconds, takes the platform read-only and pauses the loops with
  no redeploy — and a Redis outage can never *cause* a write outage.
- Off-site backups are vendor-independent and cred-safe; switching providers is an endpoint URL.
- A human, and only a human, can trigger a destructive restore; a failed verification can never leave
  a half-restored database serving traffic.
- RPO/RTO are measured (the backup workflow times the dump; the drill times the restore), not
  asserted — the README carries the numbers.
- **Coverage:** unit — `maintenance-policy`, `dr-runbook`, `dr-verify`, `approval-policy` (dr.restore),
  `autonomy-maintenance`; integration — `dr-recovery` (write-rejected-during-maintenance + the
  seed→dump→restore→verify drill against a fake bucket). Demo: `scripts/demos/43-disaster-recovery.sh`.

## Follow-ups (deferred)

- Wire Neon branching PITR automation (today the PITR path is documented + manual via the provider).
- A web surface for maintenance status + restore approvals (REST/CLI only this slice).
- Per-tenant maintenance windows (today the flag is platform-global).
- Encrypt-at-rest of the dump with a managed KMS key (today relies on bucket-side encryption).
