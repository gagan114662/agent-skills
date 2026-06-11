# Spec: Reload Platform — Evidence-Priced Autonomy: gate metrics auto-relax / re-tighten approval rules (Issue #119)

> Implements [#119](https://github.com/gagan114662/agent-skills/issues/119). Phase 5 — governance
> for the 24/7 fleet. **Builds on #13** (the pure approval-policy engine `evaluatePolicy` +
> `approval_policies` store + append-only `approval_events` audit), **#95/ADR-0042** (a #95
> auto-approve rule = an `approval_policies` row with `require_approval = false`, created via
> `upsertPolicy` / revoked via `deletePolicy`), and **#104** (the read-only Founder Console
> aggregate + reader seam). Lifecycle: **DEFINE** artifact (`spec-driven-development`) → atomic plan
> → TDD failing-first → ADR → one PR. **Video gate waived by the owner.**

## Objective

**What:** Bridge old prudence and new model capability with **measurement, not belief**. Today the
human/AI split is static doctrine: an action is either always-gated or always-auto, set by hand. This
makes that split a per-action *experiment*. For each approval **action class** the platform records
every human decision outcome as evidence (approved / rejected / edited, the edit distance for drafted
content, the time-to-decision), and a **pure pricing module** reads the trailing window and recommends
moving the boundary:

1. **Gate metrics** — every terminal human decision on a gated action is recorded into a new
   `gate_evidence` row: the action class, the outcome (`approved` | `rejected` | `edited`), the
   **edit distance** between the agent's draft and the human-edited version (when the human edited
   drafted content), and the **time-to-decision** (decided − created). Written in the same transaction
   as the #13 decision so evidence can never drift from the audit log.
2. **Pure pricing module** — `decideGatePricing(input) → { recommendation: "RELAX" | "RETIGHTEN" |
   "HOLD"; … }`. Over the trailing window (e.g. the last 100 decisions) it measures the **error rate**
   — the fraction of decisions that required human correction, `(rejected + edited) / total` — and:
   - recommends **RELAX** (create a #95 auto-approve `approval_policies` rule) when a *strict* boundary
     has a low error rate over a sufficient sample, and
   - recommends **RETIGHTEN** (revoke that rule) when a *relaxed* boundary's error rate climbs back up.
   **Hysteresis** is structural: the relax threshold is strictly below the re-tighten threshold, so the
   boundary sits in a dead band and **cannot flap** on a small wobble around one line.
3. **Invariant classes are structural, not convention** — outbound money (`billing.refund` /
   `billing.payout` / `billing.transfer`), external sends beyond drafted-and-approved
   (`external.send`), secrets access (`secrets.access`), autonomy completion (`autonomy.complete`),
   disaster-recovery restore (`dr.restore`) — **the whole #13 hard list plus secrets** — can **NEVER**
   auto-relax. This is enforced **in the type system**: a `RELAX` recommendation carries a branded
   `RelaxableActionType`, and the *only* constructor of that type (`relaxableAction`) returns `null`
   for an invariant class. A `RELAX` for an invariant is therefore **unconstructable**, and a test
   proves it (it attempts and fails — both a runtime assertion and a `@ts-expect-error` compile check).
4. **Every boundary change is a #13-audited event, surfaced in the Founder Console** — each RELAX /
   RETIGHTEN writes an append-only `gate_boundary_changes` row carrying the **measured error rate that
   earned it**, the window size, the affected #95 policy rule, and the reason. The Founder Console
   (#104) gains an `autonomyBoundaries` surface: which action classes agents currently **own**
   (auto-approved by evidence) with the error rate that earned each, plus the recent change history.

**The pure core (the testable gate):** `decideGatePricing` and `relaxableAction` — both pure,
dependency-free, in the no-DB unit job. Like #17 `decideWorkflowAction`, #96 `decideVenture`, and #105
`decideRevival`, the decision is pure and unit-tested for every branch (including the hysteresis dead
band and the invariant refusal); the `GatePricingService` does the side effects (read the window,
upsert/delete the policy rule, write the audit row).

**Why:** Owner directive — "bridge old prudence and new model capability with measurement, not belief.
The human/AI split must be a per-action experiment, not static doctrine." As models get more capable,
holding every action behind a human gate forever wastes the capability; auto-approving by gut risks
the irreversible ones. Pricing the boundary on **measured error** lets the safe classes earn autonomy
while the irreversible ones are structurally barred from ever doing so.

**Who:** The founder (Gagan), who wants the platform to *earn* autonomy on the reversible classes and
to see exactly which boundary moved and what error rate justified it; operators, who get a self-tuning
gate that never silently relaxes an invariant; the autonomy/approvals subsystems, whose `evaluatePolicy`
gate is the thing being re-priced.

## Non-goals

- **No new gating semantics.** RELAX/RETIGHTEN only ever toggle a standard #95 `approval_policies`
  row through the existing `upsertPolicy` / `deletePolicy`; `evaluatePolicy` is unchanged and remains
  the single source of truth for "does this pause for a human?".
- **No always-on behavior change.** The pricing tick is **config default-OFF** (`gatePricing.enabled`)
  exactly like #96 venture and #105 watchdog — a deployment that sets nothing keeps today's static
  gates. Only evidence *recording* is always-on (an additive in-transaction insert).
- **No spend, no egress, no new owner mutation route.** Boundary changes are driven by an
  infrastructure-time tick (like the venture/watchdog ticks), not a human-facing endpoint; the Console
  surface is strictly read-only.

## Design

### Data — two additive append-only tables (migration `0119_`)

- **`gate_evidence`** — one row per terminal human decision: `workspace_id` (FK cascade), `action_type`,
  `outcome` (`approved` | `rejected` | `edited`, CHECK-constrained), `edit_distance` (nullable; set only
  for an `edited` outcome on drafted content), `time_to_decision_ms`, `request_id` (soft ref — no FK, so
  evidence outlives request pruning), `decided_by_member_id` (set null), `created_at`. Indexed on
  `(workspace_id, action_type, created_at DESC)` for the trailing-window read.
- **`gate_boundary_changes`** — one row per RELAX / RETIGHTEN: `workspace_id` (FK cascade), `action_type`,
  `direction` (`RELAX` | `RETIGHTEN`, CHECK), `error_rate` (the measured rate that earned it),
  `window_size`, `policy_rule_id` (soft ref to the `approval_policies` row created/revoked), `reason`,
  `created_at`. This **is** the #13-style audit for boundary moves and the Console's history source.

### Pure module — `gate-pricing/`

- **`invariants.ts`** — `INVARIANT_ACTION_TYPES = [...DEFAULT_SENSITIVE_ACTIONS, "secrets.access"]`
  (derived from the #13 hard list so any future addition to it is *automatically* an invariant),
  `isInvariantAction`, the branded `RelaxableActionType`, and its sole constructor `relaxableAction`
  (returns `null` for an invariant). This is the structural guarantee.
- **`pricing.ts`** — `summarizeWindow(outcomes) → { total, approved, rejected, edited, errorRate }`,
  `decideGatePricing(input) → GatePricingDecision` (a discriminated union; the `RELAX` variant carries
  a `RelaxableActionType`, so the compiler refuses a `RELAX` for an invariant), and `editDistance(a, b)`
  (pure Levenshtein for the drafted-content measurement). Decision order: invariant refusal → relaxed
  side (RETIGHTEN above the upper rail, else HOLD) → strict side (HOLD on insufficient evidence, RELAX
  below the lower rail, else HOLD).

### IO — `GatePricingService.tick(workspaceId)`

Config default-OFF. For each action class with recorded evidence: read the trailing window, ask whether
a #95 auto-approve rule currently exists (`currentlyRelaxed`), call `decideGatePricing`, and on a
non-HOLD recommendation create (`upsertPolicy`, `require_approval = false`) or revoke (`deletePolicy`)
the rule and write the `gate_boundary_changes` audit row. The structural guarantee means the `relax`
side can only ever be reached with a non-invariant action; the service additionally re-tightens any
invariant that is somehow found relaxed.

### Console — `founder-console` `autonomyBoundaries`

A pure addition to `aggregateFounderConsole`: `owned` (currently agent-owned classes with the error
rate that earned each) + `history` (recent boundary changes, newest first), gathered by a new
`GateBoundaryReader` seam wired to the `gate-evidence` repo in `default.ts`.

## Acceptance

- **Pure pricing unit-tested incl. hysteresis** — RELAX below the lower rail with a full sample;
  HOLD in the dead band from *both* sides (the no-flap proof); RETIGHTEN above the upper rail; HOLD on
  insufficient evidence; `summarizeWindow` error-rate math; `editDistance` boundaries.
- **Invariant classes provably never relaxed** — a unit test asserts `relaxableAction` returns `null`
  for every invariant class and that `decideGatePricing` never returns RELAX for one (it HOLDs strict,
  RETIGHTENs if relaxed); a `@ts-expect-error` proves a `RELAX` literal for an invariant does not
  type-check.
- **End-to-end integration** — seed 100 fake `approved` evidence rows (a low/zero error rate) for a
  reversible action class in a fresh workspace, run `GatePricingService.tick`, and assert: a #95
  `approval_policies` auto-approve rule now exists, a `gate_boundary_changes` RELAX row was written with
  the measured error rate, and the Founder Console `autonomyBoundaries.owned` surface shows the class.
  A second test seeds a high-error window on a relaxed class and asserts RETIGHTEN (rule revoked + audit
  row). A third asserts an invariant class with a perfect window is **never** relaxed.

## Risks & mitigations

- **A boundary flaps and autonomy thrashes.** → Structural hysteresis (relax rail strictly below the
  re-tighten rail) + a minimum sample size before any RELAX. Unit-proven from both sides.
- **An irreversible class gets auto-relaxed.** → Type-level impossibility (branded `RelaxableActionType`)
  + runtime refusal + the service re-tightens a stray relaxed invariant. Proven by a failing-attempt test.
- **A silent boundary move.** → Every change is an append-only `gate_boundary_changes` row surfaced in
  the Console with the error rate that earned it — no boundary moves without an auditable reason.
- **Unintended always-on change.** → Pricing is config default-OFF; only the additive evidence insert
  is always-on, and it cannot change any gate decision by itself.
