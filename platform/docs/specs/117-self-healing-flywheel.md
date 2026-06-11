# Spec: Reload Platform — Self-Healing Flywheel: failure logs → deduped issues → fix agents (Issue #117)

> Implements [#117](https://github.com/gagan114662/agent-skills/issues/117). Phase 5 — the platform
> learns from its own failures. **Builds on #105** (the watchdog supervisor pattern: opt-in tick,
> kill-switch/maintenance gating, durable bounded tables, pure `decide`/`guards` + IO engine, #92
> launcher reuse, #13 escalation), **#25** (the secret redactor), **#57** (the GitHub issue provider
> path), **#92/#84** (`AutonomyLauncher` seam → real fix sessions), **#95/#13** (policy auto-approve),
> **#71** (`tenant_usage` dollar ceiling), **#104** (Founder Console read surface), **#99**
> (maintenance Redis flag). Lifecycle: **DEFINE** artifact (`spec-driven-development`) → atomic plan →
> TDD failing-first → ADR → one PR. **Video gate waived by the owner.**

## Objective

**What:** Make the build build the build. Every agent failure is free training data for the platform,
but today it evaporates in logs. The **Self-Healing Flywheel** turns each failure into a deduped,
fingerprinted record; synthesizes a GitHub issue for new/regressed failures on infrastructure time;
proposes a budget-capped fix-agent session for the top-ranked issue; and closes the loop when a merged
fix is verified by the absence of recurrence — reopening, escalated and human-gated, when a "fixed"
failure comes back.

Five stages, mirroring the #105 watchdog's structure:

1. **Failure fingerprinting** — `record(event)` normalizes a failure from any of five sources
   (harness crash, CI fail, #105 watchdog revival, #112 SLO breach, venture-loop error) into a stable
   **signature hash**, and upserts a workspace-scoped `failure_fingerprints` row: first/last seen,
   occurrence count, and a **sample context bundle redacted via the #25 redactor before it is
   persisted** (secrets never reach the DB, the issue body, or logs). Same failure twice ⇒ one row,
   count incremented (dedup).
2. **Issue synthesis** — a scheduled **flywheel tick** (default OFF, kill-switch + maintenance gated)
   drafts a GitHub issue via the #57 provider path for each new or regressed fingerprint above
   threshold: title, evidence (occurrences, trace ids, redacted excerpts), repro hints, and an
   acceptance-criteria template. **Dedup contract: ONE open issue per fingerprint** — more occurrences
   comment on the open issue; a recurrence-after-fix reopens it; never a duplicate. Issue creation is
   **rate-limited** per tick.
3. **Fix dispatch** — the tick proposes a fix-agent session for the **top-ranked** fingerprint-issue
   through the #92 launcher, **budget-capped** via `tenant_usage` and kill-switch gated, under a
   **hard cap on concurrent fix sessions**. **Auto-dispatch only** for fingerprint classes a #95
   policy rule allows (sensitive-by-default); everything else **queues for human approval** in the
   #104 Founder Console.
4. **Loop closure** — a merged fix **links its fingerprint** (`markFixed`). Recurrence-after-fix is
   the outcome verifier (#106): a "fixed" fingerprint that recurs is reopened with **escalated**
   priority and **excluded from auto-dispatch** (human review required), even if its class is
   normally auto-allowed.
5. **Safety** — redaction proven by test (secrets never reach issue bodies); rate-limited issue
   creation; hard cap on concurrent fix sessions; all surfaced read-only in the #104 console.

**Default-OFF.** Config `flywheel.enabled` defaults false and the background tick interval
(`FLYWHEEL_INTERVAL_MS`) defaults 0, so a deployment that opts into nothing is byte-for-byte
unchanged — exactly the #105/#96/#71 posture.

## Non-goals

- **No new failure emitters wired hot in v1.** `record(event)` is the ingest seam any source calls;
  this PR demonstrates the watchdog-revival and harness-crash classes end-to-end and leaves the
  remaining source call-sites as one-line `record(...)` adds (the seam is the contract).
- **No SLO subsystem.** #112 does not yet exist; the `slo_breach` class is a first-class fingerprint
  class so the detector can call `record(...)` when it lands. No metric/threshold engine is built here.
- **No merge/CI webhook.** `markFixed` is the linkage seam; wiring a GitHub merge webhook to call it
  is follow-up. The recurrence-after-fix verifier needs only `record(...)` (it is self-contained).

## Architecture (mirrors #105)

```
src/flywheel/
  types.ts        FailureClass, FailureEvent, FingerprintRecord, FixDispatchRecord, decisions, seams
  fingerprint.ts  (pure) fingerprintFailure(event) → { signature, title } — normalize + hash
  caps.ts         (pure) FlywheelCaps + FLYWHEEL_DEFAULTS (enabled:false) + resolveFlywheelCaps
  guards.ts       (pure) aboveThreshold / hasNewOccurrences / concurrencyAvailable / withinRateLimit
  decide.ts       (pure) decideIssueAction (draft|comment|reopen|noop), decideDispatch (auto|queue|skip)
  rank.ts         (pure) rankFingerprints — occurrence desc, then recency
  render.ts       (pure) issue body / recurrence comment / fix task — all over REDACTED fields only
  engine.ts       FlywheelEngine: record(), tickAll(), tickWorkspace(), markFixed() — all IO via seams
  default.ts      wire real repos/providers/policy/launcher/redactor
src/db/schema/flywheel.ts          failure_fingerprints + flywheel_fix_dispatches
src/db/repositories/flywheel.ts    the two store seams over the tables
drizzle/0117_self_healing_flywheel.sql (+ .down.sql)
```

The decision is **pure** (`decide.ts`); the side effects (redact + persist, file the issue, launch the
fix, enqueue the approval, mark fixed/recurred) live in `engine.ts`. The same split as #17/#96/#105.

### Failure fingerprinting

`fingerprintFailure(event)` strips volatile tokens (uuids, hex blobs, line/column numbers, addresses,
timestamps) from the failure message, then hashes `failureClass + normalizedMessage` (SHA-256, 16 hex
chars). Two different incarnations of the same bug — different ids, same shape — collide to one
signature. The signature is the dedup key (`unique(workspace_id, signature)`).

`record(event)`:
1. compute `{ signature, title }`;
2. build the sample context bundle and **redact it with the #25 `makeRedactor(event.secrets)`** before
   it touches the DB;
3. upsert: new ⇒ insert (count 1); existing ⇒ `++count`, bump `last_seen_at`, keep the first (stable)
   sample;
4. **if the pre-existing fingerprint was `fixed`** ⇒ `markRecurred`: status `recurred`,
   `excluded_from_auto_dispatch = true`, `escalated = true` (the #106 outcome verifier).

### Issue synthesis (the tick)

`tickWorkspace(wid, now)` (gates first, exactly like the watchdog):
- `caps.enabled` off ⇒ `{ skipped: "disabled" }`;
- `killSwitch(wid)` ⇒ `{ skipped: "kill_switch" }` (a `noop:kill_switch` metric, no DB writes after);
- list the workspace's open fingerprints (status ≠ `fixed`), rank them, and per fingerprint apply the
  pure `decideIssueAction`:
  - `recurred` + has issue ⇒ **reopen** (+ a recurrence comment);
  - no issue + `occurrenceCount ≥ issueThreshold` ⇒ **draft** (rate-limited to `maxIssuesPerTick`);
  - open issue + new occurrences since last sync ⇒ **comment**;
  - else **noop**.

### Fix dispatch

After synthesis, re-read open fingerprints, rank, and for the top `maxDispatchesPerTick` eligible ones
(has an open issue, not already `fixing`/`fixed`) apply the pure `decideDispatch`:
- budget exhausted ⇒ **skip** (`tenant_usage` over the #71 cap);
- no concurrency headroom (active fix dispatches ≥ `maxConcurrentFixes`) ⇒ **skip**;
- `excluded_from_auto_dispatch` (recurred-after-fix) ⇒ **queue** for a human;
- class not #95-auto-allowed ⇒ **queue**;
- else ⇒ **auto**: launch through the #92 launcher (`AGENT_FLYWHEEL_FIX=1`), record an `auto` dispatch
  row, link `fix_session_id`, set status `fixing`.

A queued dispatch enqueues a #13 approval request (`flywheel.fix.<class>`) and records a `queued`
dispatch row — surfaced in the #104 console.

### Loop closure

`markFixed(wid, fingerprintId, fixRef)` sets status `fixed` + `fixed_at` + the merged fix ref. If the
same failure recurs, `record()` flips it to `recurred`/`excluded`/`escalated` and the next tick
reopens the issue and **queues** (never auto-dispatches) the fix.

## Data model (migration `0117_self_healing_flywheel`)

`failure_fingerprints` (workspace-scoped; `unique(workspace_id, signature)`):
`id, workspace_id (FK cascade), signature, failure_class, title, first_seen_at, last_seen_at,
occurrence_count, sample_context (redacted JSON), status (open|issued|fixing|fixed|recurred),
issue_ref, issue_state, synced_occurrence_count, fix_session_id (soft ref), fix_ref, fixed_at,
excluded_from_auto_dispatch, escalated, created_at, updated_at`.

`flywheel_fix_dispatches` (the durable dispatch ledger; concurrency cap + console queue):
`id, workspace_id (FK cascade), fingerprint_id (FK cascade), mode (auto|queued), status
(dispatched|queued|done|failed), session_id (soft ref), approval_request_id (soft ref), reason,
created_at`.

Session ids are **soft references** (no FK) — session rows are audit history that may be pruned; only
`workspace_id` carries the #3 tenant boundary (`onDelete: cascade`).

## Security & safety

- **Redaction is the load-bearing invariant.** The sample bundle is redacted with the #25 redactor at
  ingest; `render.ts` reads only already-redacted fields, so a secret can never reach a GitHub issue
  body or a log. Proven by a dedicated test (a secret in `event.message` ⇒ the persisted
  `sample_context` and the filed issue body carry the mask, never the value).
- **Rate-limited issue creation** (`maxIssuesPerTick`) bounds GitHub writes per tick.
- **Hard cap on concurrent fix sessions** (`maxConcurrentFixes`) bounds spend/blast radius; enforced
  durably from `flywheel_fix_dispatches`.
- **Budget + kill switch + maintenance** gate the tick exactly as the watchdog.
- **Auto-dispatch is sensitive-by-default**: only an explicit #95 auto-approve rule for a class opts it
  in; recurred-after-fix is excluded outright.

## Testing

- **Unit (no DB):** `fingerprintFailure` (stable dedup signature across volatile ids; class separation);
  `decideIssueAction` / `decideDispatch` truth tables; `guards`; `caps` defaults; `render` (redacted
  fields only); `GitHubIssueProvider.createIssue/reopenIssue` over an injected `fetch` (network-free).
- **Integration (real Postgres):** the acceptance flow in one test — induce a harness-crash failure
  (with a secret) → assert one fingerprint row + redaction; record it again → count 2, still one row
  (dedup); `tickWorkspace` → fake filer drafts one issue + fake launcher dispatches (policy
  auto-allowed) with the fingerprint linked; kill-switch engaged → the tick is skipped (no filer /
  launcher calls); `markFixed` → recur the failure → status `recurred`/`excluded`/`escalated`; next
  tick → issue **reopened** and the fix **queued** (not auto) with a #13 request. Workspace isolation:
  a disabled workspace is untouched.

## Rollout

Default-OFF (config flag + interval 0). Enable per-tenant in the managed config layer + set
`FLYWHEEL_INTERVAL_MS`. The GitHub filer is opt-in (no token/repo ⇒ a no-op filer that returns a
synthetic ref), so CI never calls GitHub. Surfaced read-only in the #104 console.
