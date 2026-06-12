# ADR-0172: Self-Shipping Loop — agent-ok issues → cloud build agents → auto-merge within guardrails

- **Status:** Accepted (shipped in PR for #172)
- **Date:** 2026-06-12
- **Context issue:** [#172](https://github.com/gagan114662/agent-skills/issues/172)
- **Spec:** [docs/specs/172-self-shipping-loop.md](../specs/172-self-shipping-loop.md)
- **Builds on:** [ADR-0117](0117-self-healing-flywheel.md) (the supervisor pattern: opt-in tick,
  kill-switch / maintenance gating, durable bounded tables, pure `decide`/`guards` + IO engine, #92
  launcher reuse, #13 escalation, #104 console pane, #25 redactor), [ADR-0115](0115-product-planning-loop.md)
  (the dispatch loop), [ADR-0025](0025-cloud-execution.md) (`SessionManager`, the secret redactor),
  [ADR-0042](0042-autonomy-auto-approve.md) / #84 (real sessions via the `AutonomyLauncher` seam),
  [ADR-0040](0040-cloud-scale.md) (`tenant_usage` dollar ceiling), [ADR-0050](0050-founder-console.md)
  (the read-only console), [ADR-0013](0013-approval-gates.md) (approvals queue),
  [ADR-0099](0099-disaster-recovery.md) (maintenance Redis flag), [ADR-0148](0148-reliability-surface.md)
  (owner escalation).

> **Numbering note.** Spec/migration/ADR all use the `0172` slot (the issue number), per the by-issue
> numbering convention (ADR-0099's note) — to dodge sibling-workspace collisions in the shared sequence.

## Context

The owner has run one loop by hand to ship 15+ PRs: file issue → dispatch a Conductor build seat →
line-by-line review → CI → merge → rebase-train → deploy → verify. The directive: *that exact loop must
become platform infrastructure.* The hard part is not "launch an agent" or "open a PR" — #92 and #51 do
those. It is doing it **without removing a single safety gate**: a wrong auto-merge is far more dangerous
than a missed one, so the loop must fail closed to the owner on anything outside a tight, explicit set of
guardrails.

## Decision

Add a **`build-loop/` supervisor** that mirrors the #117 flywheel wholesale — a tick-driven engine with a
**pure decision core** and every side effect behind an injected seam — plus a durable, tenant-scoped
ledger, a config block, a console pane, and metrics. **Default-OFF.**

1. **Pure merge-guardrail core.** `decideMergeGuardrails` is the safety heart and is a total function:
   merge ONLY when `agentOkLabeled && reviewerPass && ciGreen && !protectedPathTouched &&
   diffWithinSizeCap`; otherwise **escalate**, with the reason naming the FIRST violated guardrail
   (checked in that fixed order). It is impossible to reach `RepoHost.merge` except through this
   function returning `merge`. Exhaustively unit-tested.

2. **Protected paths are structural, not advisory.** `DEFAULT_PROTECTED_PATHS` (approvals, billing,
   auth, crypto, secrets, config `layers.ts`, the autonomy kill switch, maintenance, anything
   `*secret*`/`*credential*`) force human review. A PR touching one can never auto-merge — and the
   reviewer rubric *also* FAILs it (`gates_intact`), so it is gated at both review and merge (defense in
   depth). The list is config-replaceable by a managed-layer operator, never wideanable by a lower layer.

3. **Reviewer = the pure house rubric by default.** `evaluateHouseRubric` (tests present, migrations
   numbered by the issue number, new tables workspace-scoped, no secret-shaped added lines, gates intact)
   is the deterministic, zero-spend default reviewer; production wraps it with a model session whose
   structured output is captured. The rubric is the auto-review spine and is unit-tested per check.

4. **Reuse, don't rebuild.** Build/review/revise sessions launch through the #92 `AutonomyLauncher`
   (subscription/platform auth via #68); escalations create a **pending** #13 request (so they appear in
   the existing audit feed and the console) — no new audit subsystem, no change to `approvals/policy.ts`.
   Budget via #71, kill switch via #17, maintenance via #99, redaction via #25.

5. **The repo host is a seam with a no-op default.** `RepoHost` models observe-PR / diff / CI / comment /
   merge / merge-from-main. The default carries **no GitHub credentials** (observes no PR, refuses
   merge), so the loop is wired-but-inert and CI never ships. A deployment injects a `gh`-backed adapter.
   Integration tests inject a programmable fake — exactly the criterion-7 "fake repo host".

6. **Auto-revert is proposed, never executed.** Post-merge verification escalates a revert proposal to
   the owner; the engine has no code path that executes a revert.

## Consequences

- **Positive.** The mechanical ship-loop runs without a human on the happy path, while "outside
  guardrails → owner" is a *structural* property. The pure core makes the safety contract testable in
  isolation (43 unit tests); the seam design makes the full loop testable against fakes with zero
  GitHub/model spend (2 integration tests on real Postgres). Default-OFF + no-op repo host ⇒ zero
  behavior change until an operator opts in via `buildLoop.enabled` + `BUILDLOOP_INTERVAL_MS` + a real
  `RepoHost`.
- **Negative / deferred.** The production `gh`-backed `RepoHost` (real `gh pr merge` / branch update) and
  the production reviewer/verifier sessions are thin adapters left to the deployment — this PR ships the
  contracts + the no-op/rubric defaults, not the live GitHub wiring. The `IssueSource` watch path is a
  seam (the explicit `recordIssue` route is the default ingest).

## Alternatives considered

- **Merge in the GitHub provider / engine directly.** Rejected: it would scatter the guardrail check and
  make "can this merge?" non-obvious. Funnelling every merge through one pure function is the safety win.
- **A new native audit source.** Rejected as over-build: the runs + reviews ledger is the full-action
  audit surface, and escalations already flow through #13 into the audit feed.
- **Always run a model reviewer.** Rejected as the default: it spends per review and is non-deterministic
  in CI. The rubric is the deterministic floor; the model reviewer is the opt-in ceiling.
