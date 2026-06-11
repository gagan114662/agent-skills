# ADR-0119: Evidence-Priced Autonomy — gate metrics auto-relax / re-tighten approval rules

- **Status:** Accepted (shipped in PR for #119)
- **Date:** 2026-06-10
- **Context issue:** [#119](https://github.com/gagan114662/agent-skills/issues/119)
- **Spec:** [docs/specs/119-evidence-priced-autonomy.md](../specs/119-evidence-priced-autonomy.md)
- **Builds on:** [ADR-0013](0013-approval-gates.md) (pure `evaluatePolicy`, `approval_policies` store,
  append-only `approval_events` audit, the `DEFAULT_SENSITIVE_ACTIONS` hard list),
  [ADR-0042](0042-autonomy-auto-approve.md) / #95 (a #95 auto-approve rule = an `approval_policies`
  row with `require_approval = false`; `upsertPolicy` / `deletePolicy`),
  [ADR-0050](0050-founder-console.md) (read-only Console aggregate + reader seam),
  [ADR-0049](0049-venture-loop.md) / [ADR-0105](0105-fleet-watchdog.md) (pure `decide` + IO
  orchestrator + config default-OFF tick pattern).

> **Numbering note.** Spec / migration / ADR all use the `0119` slot (the issue number), per the
> project's by-issue numbering convention (see ADR-0099's note) — chosen to dodge sibling-workspace
> collisions in the shared migration sequence.

## Context

The human/AI split is static doctrine. An approval action class is either always-gated
(`DEFAULT_SENSITIVE_ACTIONS`, or a workspace rule with `require_approval = true`) or always-auto (a #95
rule with `require_approval = false`), and a human sets it by hand once. As models get more capable
that is wrong in both directions: holding a reversible class behind a human gate forever wastes the
capability, while auto-approving by gut risks the irreversible ones. The owner directive: **"bridge
old prudence and new model capability with measurement, not belief. The human/AI split must be a
per-action experiment, not static doctrine."**

The platform already records *that* a decision happened (the #13 `approval_events` log) but not the
*signal* needed to price a boundary: was the agent's draft accepted as-is, corrected, or rejected, and
how much was corrected. And nothing closes the loop from that signal back to the gate.

The hard parts are not "flip a policy row". They are: (a) capturing a decision *outcome* (not just the
event) as durable evidence without drifting from the audit log; (b) a boundary rule that **cannot
flap** as the error rate wobbles; (c) making the irreversible classes **impossible** to auto-relax in a
way a future code change can't quietly undo; and (d) keeping every boundary move auditable and visible.

## Decisions

1. **Evidence is captured in the same transaction as the #13 decision.** `approveAndLock` and
   `rejectRequest` already append the `approval_events` audit row in their guarded transaction; they now
   also insert one `gate_evidence` row in that same transaction — outcome (`approved` / `rejected` /
   `edited`), `time_to_decision_ms` (`now − created_at`, both already in hand), `request_id` (soft ref),
   and, for an `edited` approval, the `edit_distance`. Atomic with the decision, so evidence can never
   drift from the audit log. The capture is **always-on and additive**: it records signal but, by
   itself, changes no gate decision.

2. **The "edited" outcome is a first-class decision on the approve path.** A reviewer may approve a
   drafted-content action *with edits* (`POST /approvals/:id/approve` with an optional
   `edit: { field, value }`). `approveAndLock` then computes `editDistance(original, value)` (pure
   Levenshtein), updates the request payload so the executor runs the **edited** draft, and records the
   decision as `edited` with that distance — the per-action correction signal the pricer reads.
   Absent an `edit`, the outcome is `approved` exactly as before (fully backward-compatible).

3. **The pricing decision is pure; the service does the side effects.** `decideGatePricing(input) →
   { recommendation: "RELAX" | "RETIGHTEN" | "HOLD"; … }` over a `summarizeWindow` of the trailing
   outcomes, in a deliberate order: invariant refusal → relaxed side → strict side — exactly like
   `decideWorkflowAction` / `decideVenture` / `decideRevival`. Every branch is a unit test. The
   `GatePricingService.tick` reads the window, asks `currentlyRelaxed`, calls the pure decision, and
   only then upserts/deletes the `approval_policies` row and writes the audit row.

4. **Hysteresis is structural, so the boundary cannot flap.** Two rails: `relaxBelowRate` (default
   0.05) strictly below `retightenAboveRate` (default 0.15). A *strict* boundary relaxes only when the
   error rate is below the lower rail over a sufficient sample (`minSamples`, default 100); a *relaxed*
   boundary re-tightens only when the error rate climbs above the upper rail. Between the rails is a
   dead band where whichever side you are on **HOLDs** — a small wobble around one line can never flip
   the boundary. The no-flap property is unit-proven from both sides at a mid-band error rate.

5. **Invariant classes are barred in the type system, not by convention.** A `RELAX` recommendation
   carries a branded `RelaxableActionType`, whose *only* constructor `relaxableAction(actionType)`
   returns `null` for any action in `INVARIANT_ACTION_TYPES`. That list is
   `[...DEFAULT_SENSITIVE_ACTIONS, "secrets.access"]` — derived from the #13 hard list, so outbound
   money, external sends, `autonomy.complete`, `dr.restore`, **and any future addition to the hard
   list** are automatically invariant, plus secrets access. A `RELAX` for an invariant is therefore
   **unconstructable**: `decideGatePricing` HOLDs a strict invariant and RETIGHTENs a relaxed one, and a
   test proves the impossibility — a runtime assertion that `relaxableAction` is `null`, and a
   `@ts-expect-error` that a hand-written `RELAX` literal for an invariant does not compile.

6. **Every boundary change is an append-only audited event, surfaced in the Founder Console.** Each
   RELAX / RETIGHTEN writes a `gate_boundary_changes` row carrying the **measured error rate that
   earned it**, the window size, the affected policy rule, and the reason — the #13-style audit for
   boundary moves and the Console's history source. The #104 Console gains a pure `autonomyBoundaries`
   surface (`owned` classes with their earning error rate + recent `history`), gathered by a new
   read-only `GateBoundaryReader` seam — no new mutation authority.

7. **Default-OFF, like every other infrastructure-time loop.** `GatePricingService.tick` is gated by
   `gatePricing.enabled` config (default false) and is driven by an infrastructure-time tick, not a
   human-facing endpoint, mirroring #96/#105. A deployment that sets nothing keeps today's static gates;
   only the additive evidence insert is always-on.

## Consequences

- Reversible action classes can **earn** autonomy from measured error, and the earning is auditable to
  the exact error rate; the irreversible classes are structurally barred from ever doing so.
- The boundary is self-tuning but cannot thrash (hysteresis) and cannot silently move (audit row).
- New surface is additive: two append-only tables, one pure module, one always-on in-transaction insert,
  one optional approve-path `edit`, one read-only Console surface, one default-OFF tick. `evaluatePolicy`
  — the single source of truth for gating — is untouched.
- **Trade-off:** the pricer toggles a *workspace* policy rule, which applies to the whole action class,
  not a per-request decision. That is intentional: the boundary being priced *is* the class-level gate.
  Per-request nuance (amount thresholds) remains the existing `maxAutoAmount` mechanism, unchanged.
