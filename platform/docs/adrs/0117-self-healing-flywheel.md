# ADR-0117: Self-Healing Flywheel — failure logs → deduped issues → fix agents on a cron

- **Status:** Accepted (shipped in PR for #117)
- **Date:** 2026-06-10
- **Context issue:** [#117](https://github.com/gagan114662/agent-skills/issues/117)
- **Spec:** [docs/specs/117-self-healing-flywheel.md](../specs/117-self-healing-flywheel.md)
- **Builds on:** [ADR-0105](0105-fleet-watchdog.md) (the supervisor pattern: opt-in tick, kill-switch
  / maintenance gating, durable bounded tables, pure `decide`/`guards` + IO engine, #92 launcher reuse,
  #13 escalation), [ADR-0025](0025-cloud-execution.md) (`SessionManager`, the secret redactor),
  [ADR-0017](0017-autonomy.md) (pure-core/IO split; kill switch), [ADR-0042](0042-autonomy-auto-approve.md)
  / #84 (real sessions via the `AutonomyLauncher` seam; #95 policy auto-approve),
  [ADR-0040](0040-cloud-scale.md) (`tenant_usage` dollar ceiling), [ADR-0050](0050-founder-console.md)
  (the read-only console surface), [ADR-0013](0013-approval-gates.md) (approvals queue),
  [ADR-0099](0099-disaster-recovery.md) (maintenance Redis flag).

> **Numbering note.** Spec/migration/ADR all use the `0117` slot (the issue number), per the project's
> by-issue numbering convention (see ADR-0099's note) — chosen to dodge sibling-workspace collisions in
> the shared migration sequence.

## Context

The platform now runs agents 24/7 (#17/#84) and supervises stalled ones (#105), but every failure —
a harness crash, a CI red, a watchdog revival, an SLO breach, a killed venture — still dies in a log
file. The owner directive: *the build builds the build*; each failure is free training data that today
evaporates. The gap is the full loop: turning a raw failure into a deduped record, into a tracked
issue, into a fix agent, and verifying the fix held — without flooding GitHub with duplicates, without
leaking secrets into issue bodies, without spending unboundedly, and without auto-dispatching a fix for
a failure that has *already* defeated one fix.

The hard parts are not "open an issue" or "launch an agent" — #57 and #92 already do those. They are:
(a) a **stable fingerprint** so the same bug seen twice is one issue, not two; (b) **redaction at
ingest** so a secret echoed into a failure message never reaches a public issue; (c) a **bounded,
gated** synthesis+dispatch loop (rate limit, concurrency cap, budget, kill switch) that is **default
OFF**; (d) an **outcome verifier** — recurrence-after-fix — that downgrades a "fixed" failure back to
human review instead of blindly re-dispatching.

## Decisions

1. **Mirror the #105 watchdog wholesale.** The flywheel is a second infrastructure-time supervisor, so
   it reuses #105's proven shape verbatim: an opt-in `start(intervalMs)` timer (default 0), a
   `tickAll()` that checks **maintenance before any DB call** and groups work by workspace, a
   `tickWorkspace()` that gates on the config `enabled` flag then the #17 kill switch, a pure
   `decide`/`guards` core with an IO engine, durable bounded tables, and `default.ts` wiring real
   seams. A reviewer who knows the watchdog already knows this. The decision is one of *consistency*:
   no new gating model, no new lifecycle.

2. **Fingerprint = normalize then hash; the signature is the dedup key.** `fingerprintFailure` strips
   volatile tokens (uuids, hex, numbers, timestamps) and SHA-256-hashes `class + normalized message`.
   `unique(workspace_id, signature)` makes "same failure twice = one row" a database invariant, not a
   convention. The `failure_class` is part of the hash so an identical message from two sources stays
   two fingerprints (different repro, different fix).

3. **Redact at ingest, render from redacted fields only.** `record()` runs the sample context bundle
   through the #25 `makeRedactor(event.secrets)` **before** the row is written. Everything downstream —
   the issue body, the recurrence comment, the fix task, the console — reads only the persisted,
   already-redacted `sample_context`. Redaction is therefore impossible to forget at a render site: a
   secret has no path to a GitHub issue. This is asserted by a dedicated test (the load-bearing safety
   invariant).

4. **ONE open issue per fingerprint, enforced by the fingerprint row, not GitHub.** The fingerprint
   stores its `issue_ref` + `issue_state` + `synced_occurrence_count`. The pure `decideIssueAction`
   reads those: no ref + over threshold ⇒ draft; ref + open + new occurrences ⇒ comment; recurred ⇒
   reopen; else noop. The dedup contract lives in our own state machine, so it holds even if the GitHub
   read path is unavailable. Issue creation is rate-limited (`maxIssuesPerTick`).

5. **Fix dispatch is sensitive-by-default and triple-bounded.** The top-ranked eligible fingerprint is
   dispatched through the #92 launcher (so it passes the same #71 admission chokepoint) **only** if a
   #95 policy rule auto-approves its class; otherwise it queues a #13 approval request for the #104
   console. Three hard bounds: the #71 `tenant_usage` budget (skip when over), a `maxConcurrentFixes`
   cap enforced durably from `flywheel_fix_dispatches`, and `maxDispatchesPerTick` (one per tick by
   default). No class is auto-allowed implicitly — only an explicit auto-approve rule opts one in.

6. **Recurrence-after-fix is the outcome verifier (#106), and it removes auto-dispatch.** A merged fix
   calls `markFixed` (status `fixed` + the fix ref). When `record()` later sees a failure whose
   fingerprint is already `fixed`, it flips it to `recurred` + `excluded_from_auto_dispatch` +
   `escalated`. The next tick reopens the issue and **queues** the fix for a human — never re-dispatches
   automatically. A fix that didn't hold is exactly the case where a human must look.

7. **The GitHub issue-creation method is additive to #57; default wiring is a no-op filer.** #57's
   `IssueProvider` only read + commented; we add `createIssue`/`reopenIssue` to the concrete
   `GitHubIssueProvider` (the Linear provider and existing fakes are untouched — the interface is not
   widened). The engine depends on a narrow `IssueFiler` seam, and `default.ts` wires a **no-op filer**
   (synthetic ref) unless a real GitHub provider + token + repo target is configured, so CI/tests never
   call GitHub.

## Consequences

- **Default-OFF, additive.** `flywheel.enabled` defaults false, `FLYWHEEL_INTERVAL_MS` defaults 0, the
  filer defaults to no-op, the Founder Console pane is optional and zero-valued when unwired. A
  deployment that opts into nothing is unchanged — the #105/#96/#71 posture. The config block is added
  to **both** `mergeSettings` and `mergeLayers` in `config/layers.ts` (the documented gotcha: a block
  missing from either silently drops at runtime).
- **Observability.** `flywheel_ticks_total` + `flywheel_actions_total{action}` (bounded action labels:
  `ingest:new`/`ingest:dedup`/`issue:draft`/`issue:comment`/`issue:reopen`/`dispatch:auto`/
  `dispatch:queue`/`dispatch:skip:*`/`noop:kill_switch`) — tenant ids are never labels.
- **Surfaced read-only in #104.** The console gains a `selfHealing` view (open/issued/fixing/fixed/
  recurred counts + queued/auto dispatch counts) and an attention reason when a recurred-after-fix
  fingerprint needs human review. No mutations — fixes approve/queue through their existing surfaces.
- **Deferred:** hot-wiring the remaining four failure emitters to `record(...)` (the seam is the
  contract; this PR proves the watchdog-revival + harness-crash classes); the #112 SLO detector; a
  GitHub merge webhook → `markFixed`; updating the first sample bundle on dedup (we keep the first,
  stable one).
- **Tenant isolation.** Every query filters `workspace_id`; the tick gates per workspace; a disabled or
  kill-switched workspace is provably untouched (integration test).
