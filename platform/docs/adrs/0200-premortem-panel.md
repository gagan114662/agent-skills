# ADR-0200: Premortem panel on the weekly founder report — the company answers to its own failure list

- **Status:** Accepted (shipped in PR for #200)
- **Date:** 2026-06-14
- **Context issue:** [#200](https://github.com/gagan114662/agent-skills/issues/200) — the standing
  premortem: *assume the autonomy roadmap (#187–#197) shipped perfectly and the company still failed.*
  Every venture decision and roadmap item must answer to its seven failure modes.
- **Builds on:** [ADR-0173](0173-founder-briefings.md) (the weekly founder report this panel rides on —
  pure composer in `aggregate.ts`, IO seams in `service.ts`, real repos in `default.ts`, read-only,
  default-OFF, idempotent delivery watermark), [ADR-0187](0187-venture-factory.md) (the falsifiable
  **edge gate** — FM#1 — and the pure `composePremortemPanel` it first introduced), [ADR-0106](0106-outcome-verifiers.md)
  (`verifier_results` — the externally-verified metric tier, FM#2), [ADR-0013](0013-approval-gates.md)
  (the approvals queue — irreversible-class actions FM#4, rubber-stamp/override FM#5/#7),
  [ADR-0197](0197-venture-memory-planning.md) (the planning loop that already cites #200 in every
  go/no-go — AC3).

## Context

The premortem (#200) is the company's standing list of *why the autonomy roadmap can ship perfectly and
the company still fail*: no real edge, self-reported metrics, verification that never touches reality,
irreversible mistakes, un-budgeted owner attention, prompt injection, and no adversary on the payroll.
Acceptance criterion **AC2** asks the weekly founder report to surface a **premortem panel** so those
failure modes are never invisible behind a green dashboard.

A pure `composePremortemPanel` (the five gauges + warning flags) already existed — it was introduced
with the venture factory (#187) and is fully unit-tested — but it was **never wired into the report**:
nothing gathered its inputs and nothing rendered it. AC3 (the planning loop cites #200 in every
go/no-go) was already satisfied by #197 (`decideWeeklyPlan` always emits a `premortem` citation with
`premortemCited: true`, asserted in `venture-memory-plan.test.ts`).

So this change is **wiring, not new machinery**: connect the existing pure panel to the report from the
seams that already exist, reusing them read-only — never fabricating a number.

## Decision

Surface the panel as an **optional composable overlay** on the weekly report, exactly like the #194
finance section and #189 acquisition section: when its counters are not supplied the report renders
**byte-for-byte as before** and `WeeklyReport.premortem` is `null`. This keeps every existing test green
and means a briefings deployment that hasn't wired the panel is unchanged.

### The five gauges, sourced from real seams (no new query authority)

| # | Failure mode | Gauge | Source seam |
|---|---|---|---|
| FM#1 | No edge generation | % of live ventures with a **qualified falsifiable edge** | #187 `listVentures` (non-archived) × candidate `edgeStatus === "qualified"` |
| FM#2 | Self-reported metrics are fiction | % of surfaced metrics that are **externally verified** | #106 `listVerifierResults` (passed\|failed — touched reality; `errored` is not a metric) vs #96 self-reported scorecard scores (`listEvaluations`) |
| FM#4 | Irreversibility | **irreversible-action count** in the window | #13 `listRequests` × `isIrreversibleAction` (new pure classifier in `approvals/policy.ts`) |
| FM#5 | Owner attention is budgeted | **attention spend** (decisions presented vs the daily top-N) + **rubber-stamp rate** | decision-queue size + #13 approvals decided in-window with near-zero latency (`rubberStampSeconds`) |
| FM#7 | Adversary on the payroll | **owner-override rate** (the taste gap) | #13 approvals the owner **rejected** in the window |

`flags[]` calls out any gauge in the danger zone (a venture without an edge, self-reported metrics, an
over-budget attention queue, an ≥80% rubber-stamp rate), and the rendered weekly digest leads its
premortem sentence with the gauges and appends the first flag — so the danger survives the word clamp
and the brief **can never quietly read "all green" while an edge is missing or the metrics are fiction.**

### Where each piece lives (the #173 split, unchanged)

- **`aggregate.ts` (pure):** `composePremortemPanel` (pre-existing) is now composed inside
  `composeWeeklyReport`; `premortem?` added to `WeeklyReportInput`, `premortem: PremortemPanel | null` to
  `WeeklyReport`, plus a one-sentence renderer. No IO.
- **`approvals/policy.ts` (pure):** `IRREVERSIBLE_ACTIONS` + `isIrreversibleAction` — the FM#4
  reversibility taxonomy, colocated with the action-type constants and the existing
  `DEFAULT_SENSITIVE_ACTIONS` (a test asserts every irreversible action is also sensitive-by-default).
- **`caps.ts` + `config/schema.ts`:** two new knobs — `attentionBudget` (the daily top-N, default **3**,
  #200 §5) and `rubberStampSeconds` (near-zero-latency threshold, default **60**). The briefings block is
  replace-merged, so adding fields needs no `layers.ts` allowlist change.
- **`service.ts`:** an **optional** `PremortemReader` seam returns the raw counts; the service owns
  `attentionBudget` (a caps concern) and injects it, so the panel and the rest of the brief read one
  source of truth.
- **`default.ts`:** the production reader, composed entirely from existing repos.

## Consequences

- **No migration, no new table** — pure reuse of existing repos. Zero sibling-workspace migration
  collision risk, and colocation stays green (no governed table touched).
- **Default-OFF preserved.** The panel ships whenever the briefings feature delivers (itself default-OFF
  via `briefings.enabled`); the composer is backward-compatible (absent counters ⇒ `null`).
- **Reversibility taxonomy now has one home** (`isIrreversibleAction`), reusable by any future read that
  needs to count irreversible exposure.
- **Honest counting, documented.** `errored` verifications are excluded from metrics; a launch
  (`venture.bootstrap`) is reversible and deliberately *not* counted as irreversible; an override is a
  *rejected* request. The estimate-labeling discipline (#200 mode 2) is inherited from the existing
  finance/acquisition sections (CAC/verified-share are already UNVERIFIED-labeled).
- **AC3** was already met by #197; a test pins it. **AC2** is now met end-to-end (pure → seam → real
  repos → rendered line + structured `premortem` object on the read route).
