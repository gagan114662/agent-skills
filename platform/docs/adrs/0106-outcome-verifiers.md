# ADR-0106: Outcome Verifiers — measured gates for the claims without test suites

- **Status:** Accepted (shipped in PR for #106)
- **Date:** 2026-06-11
- **Context issue:** [#106](https://github.com/gagan114662/agent-skills/issues/106)
- **Spec:** [docs/specs/106-outcome-verifiers.md](../specs/106-outcome-verifiers.md)
- **Builds on:** [ADR-0013](0013-approval-gates.md) (the #13 approval queue + `createRequest` — the
  escalation sink), [ADR-0017](0017-autonomy-and-pooling.md) (the per-workspace kill switch + the pure
  `decide` / IO orchestrator / config-default-OFF tick pattern), [ADR-0099](0099-disaster-recovery.md)
  (the maintenance flag every infra-time loop self-gates on), [ADR-0112](0112-sre-loop.md) /
  [ADR-0117](0117-self-healing-flywheel.md) (the engine/`decide`/`caps`/`guards` module split + the
  escalate-to-#13 pattern this mirrors wholesale).
- **Consumed by:** [ADR-0049](0049-venture-loop.md) (#96 scorecard), ADR-0117 (#117 fix-held closure),
  [ADR-0119](0119-evidence-priced-autonomy.md) (#119 pricer).

> **Numbering note.** Spec / migration / ADR all use the `0106` slot (the issue number), per the
> project's by-issue numbering convention (see ADR-0099's note) — chosen to dodge sibling-workspace
> collisions in the shared migration sequence.

## Context

The platform can verify *code* cheaply: a test suite turns correctness into a green/red bit, and the
fleet excels exactly where that bit exists. But the claims that decide whether a venture is *real* have
no test suite — is the deploy live, did real money move, did a growth metric move, did a fix hold? Today
those are asserted and quality plateaus at "plausible" (premortem #7). Nothing turns "looks deployed"
into a measured, durable, audited verdict, and nothing forces a *failed* outcome to surface rather than
being quietly assumed true.

The hard parts are not "fetch a URL". They are: (a) keeping the **decision pure** so "the gate is
measured" is a property of the code, not of a mock; (b) making a failed verification **impossible to
silently pass** (it must open an escalation); (c) keeping every verdict **durable + tenant-scoped +
redacted**; and (d) exposing one **shared evidence signal** that the venture scorecard, the flywheel,
and the autonomy pricer can all read without coupling to each other.

## Decisions

1. **A verifier is a pure `(claim, observation) → VerifierOutcome` function; the runner does all IO.**
   The registry (`registry.ts`) holds one pure function per kind (`deploy_live`, `revenue_real`,
   `growth_metric`, `fix_held`) and a kind-agnostic `evaluateClaim` dispatch. No IO/clock/randomness, so
   a given (claim, observation) is deterministic and unit-tested at its threshold boundary. The
   `VerifierRunner` (`engine.ts`) gathers the observation through a seam, evaluates through the pure
   registry, persists, and escalates — every side effect is a seam, exactly like #112/#117.

2. **Failed verifications open a #13 escalation; they never silently pass.** A `failed` outcome enqueues
   an `approval_requests` row (`actionType: "verifier.failed"`) through the same #13 sink the SRE loop
   uses, and the returned `request_id` is stamped onto the evidence row. A pass opens nothing. This is
   the structural "no silent pass" guarantee — the only way past a failed gate is a recorded human
   decision.

3. **An `errored` observation is a third outcome, not a fail.** A probe that *could not measure* (deploy
   unreachable for a transport reason, revenue source unavailable) records `errored` and **does not
   escalate** — escalating on an un-measurable probe would cry wolf. Only a measured `failed` escalates.

4. **Evidence is one additive, append-only table (`verifier_results`, migration `0106_`).** No existing
   table is touched (zero sibling-migration collision risk). `claim_ref` and `escalation_request_id` are
   **soft references** (no FK) so a verdict outlives a pruned deployment/venture/request; only
   `workspace_id` carries the #3 tenant boundary (`onDelete: cascade`). `detail` is redacted via the #25
   redactor before persist. The `(workspace_id, kind, claim_ref, created_at)` index backs the
   latest-verdict read.

5. **Default-OFF, kill-switch- and maintenance-gated.** `verifiers.enabled` defaults false and
   `VERIFIERS_INTERVAL_MS` defaults 0, so wiring the runner changes nothing until a deployment opts in.
   `tickAll` checks the #99 maintenance flag before any DB call; each workspace pass checks `enabled`
   then the #17 kill switch — identical to the venture/watchdog/SRE/flywheel loops.

6. **Consumption is a shared read API, not cross-subsystem coupling.** `verifier_results` + the pure
   `summarizeOutcomeEvidence` reducer + `latestResult` / `listVerifierResults` are the seam #96, #117,
   and #119 read. The venture scorecard gates "done" on passing `deploy_live`/`revenue_real`/
   `growth_metric` rows; the flywheel reads `fix_held`; the pricer folds passing/failing verifiers into
   its trailing window. Each reads the rows; none calls into the verifier runner. The read surface is
   exposed read-only at `GET /workspaces/:wid/verifier-results` (#19-guarded).

## Consequences

- **Positive:** "looks good" becomes a measured, durable, audited verdict; a failed outcome cannot be
  silently assumed true; three subsystems share one evidence signal without coupling; the registry is
  open for new kinds (a pure fn + a taxonomy entry); zero behavior change until opt-in.
- **Negative / trade-offs:** the default probes read existing surfaces (#73/#98/#112/#117) rather than a
  dedicated external uptime checker — a richer probe is a later seam. The in-loop wiring of #96/#117/#119
  consumes the evidence rows additively; this PR ships the rows + read API + one escalation path, not a
  rewrite of those loops. `claim_ref` being a soft ref means a verdict can outlive its subject (by
  design — evidence is history).
- **Neutral:** mirrors the established infra-time-loop shape (pure `decide` + IO engine + `caps` +
  default-OFF tick + escalate-to-#13), so it carries no new architectural concept.
