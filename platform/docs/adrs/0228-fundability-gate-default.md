# ADR-0228: Enforce the YC-fundability gate by default — owner-workspace-first, with the founding venture marked as a zero-budget scaffold

- **Status:** Accepted (shipped in PR for #228)
- **Date:** 2026-06-17
- **Context issue:** [#228](https://github.com/gagan114662/agent-skills/issues/228) — the #96 Venture-Loop
  fundability gate exists but is **inert**: `venture.enabled` defaults OFF for every workspace, so nothing
  stops the fleet from pointing autonomy at an unscored stub. Worse, the founding/activation venture (#230)
  reaches idea status `funded` with a build epic but never earns a passing scorecard, so the founder console
  shows it as an "active funded venture" with moat score 0 — a stub masquerading as a real company.
- **Builds on:** [ADR-0049](0049-venture-loop.md) (the #96 SOURCE→RESEARCH→SCORE→DECIDE loop, the
  `Scorecard.funded` flag, the `decideVentureAdmission` pure gate + `VentureAdmission` controller +
  `ventureGatedLauncher` decorator + `hasPassingUnexpiredScorecard` read — ALL reused unchanged), the #230
  activation kickoff (`VentureService.kickoffFounding`, which already keeps the admission gate closed by
  deliberately not setting the scorecard `funded`), [ADR-0035](0035-config-layering.md) (the layered
  feature-flag config), [ADR-0295](0295-deliverable-delivery.md) / [ADR-0188](0188-venture-monetization-rails.md)
  (the two-pronged `enabled` + `ownerWorkspaceOnly` + `ownerWorkspaceId` owner-workspace-first gate this
  mirrors), [ADR-0012](0012-acp-a2a.md) (the "derive, don't store" rule — the scaffold marker is **derived**,
  not a new column), [ADR-0200](0200-premortem-panel.md) (the standing premortem this answers to).

## Context

Issue #228 found, live on ipop.ai, that the quality apparatus the roadmap built (#49/#96 fundability gate,
#103 moat, #107 portfolio) was **toggled off** and the one activated venture was a self-referential
bootstrap stub flagged `moat score 0, accrualsInWindow 0, flaggedStagnant` yet sitting in the pipeline as
`active`. The gate machinery is fully built and wired — the gap is purely **defaults + honesty**:

1. The admission gate (`decideVentureAdmission` / `VentureAdmission` / `ventureGatedLauncher`) already rejects
   an autonomy launch when the workspace lacks a passing, unexpired #96 scorecard — but only when
   `venture.enabled` is true, and that defaults false everywhere.
2. The founding venture already gets **zero autonomy budget** with the gate on (kickoff never marks the
   scorecard `funded`), but the console still counts it as `funded` — so a founder can't tell a stub apart
   from a cleared venture.

## Decision

### 1. Make the gate real and enforceable — owner-workspace-first, default OFF behind a flag

Rather than the issue's literal "default the gate ON for every existing workspace," we roll enforcement out
**owner-workspace-first**, exactly like `delivery` (#295) and `monetization` (#188): the master `enabled`
flag stays **default OFF**, plus `ownerWorkspaceOnly` (default **true**) + `ownerWorkspaceId`. A new pure
`isVentureGateEnabledForWorkspace(caps, workspaceId)` returns true only when `enabled` is on AND
(`!ownerWorkspaceOnly` OR the workspace is the named owner). Turning `enabled` on without naming an owner
enforces on **nobody** — the safest default.

**Why not blanket-ON for all tenants?** Flipping the gate on globally would block autonomy on *every*
workspace whose founding venture hasn't yet earned a passing scorecard — regressing #230 ("activation
launches real work") platform-wide, and violating the #200 reversibility directive (irreversible-feeling
breakage with a wide blast radius). Owner-first lets us dogfood real enforcement on ipop's OWN workspace
first — which is the exact "real workspace" the issue inspected — then broaden by setting
`ownerWorkspaceOnly = false` once proven. The owner workspace reuses the established #258 marker
(`RELOAD_MARKETING_OWNER_WORKSPACE_ID`); `RELOAD_VENTURE_OWNER_WORKSPACE_ID` overrides it.

**No migration.** `venture.enabled` is config-resolved, not a per-workspace DB column, so "default existing
workspaces on" is a pure config/env flip — no `0228_*.sql`. A migration would only be needed to persist a
per-workspace override, which we deliberately do not introduce (the layered config already scopes per
workspace).

### 2. The founding venture is a clearly-marked zero-budget scaffold (derived, no new state)

A terminal-`FUND` venture that lacks a passing, unexpired #96 scorecard is, structurally, an owner-activated
**scaffold** — funded into a build epic by the owner's #230 activation choice, but not yet cleared by the
adversarial #96 bar, and therefore on **zero autonomy budget** (the admission gate keeps blocking it). We
surface this honestly in the founder console: `VenturePipelineView` gains a `scaffolds` count, and such
ventures are split OUT of `funded`. The signal is **derived** from the existing
`passingScorecardIdeaIds` read (per ADR-0012 "derive, don't store") — no new column, no enum change, no
migration. Backward compatible: a snapshot that doesn't supply `hasPassingScorecard` (older callers) is
counted exactly as before.

## Premortem (#200) answers

- **Self-reported metrics are fiction:** the scaffold/funded split keys ONLY off structural scorecard state
  (`funded` + `verdict` + `expiresAt`), never a self-reported estimate. The FUND path itself still requires
  external demand evidence (#101/#222) via the existing `demandScoreFromExternal` overlay — unchanged.
- **Verification touches reality:** admission queries the real `hasPassingUnexpiredScorecard` DB read at
  launch time; the gate fails **closed** (no scorecard → no autonomy spend).
- **Reversibility / blast radius:** default OFF, owner-workspace-first, one env flag — instantly reversible,
  bounded to the named workspace.
- **Injection defense:** no untrusted input is parsed anywhere in this change; every decision is structural.
- **Owner holds the keys:** nothing here ships, sends, or spends money. The gate only *blocks*; it adds no
  new autonomous capability and no new #13 action. Borderline scores still ESCALATE to the owner via the
  unchanged #96 loop.

## Consequences

- With `RELOAD_VENTURE_ENABLED=true` + the owner workspace named, the owner workspace cannot launch autonomy
  on an unscored/failing venture; a passing #96 scorecard (FUND) unlocks it. Every other tenant is unchanged.
- The console no longer counts an owner-activated stub as `funded`; it reads as a `scaffold` (zero autonomy
  budget until it clears the bar) — directly satisfying "never an active stub with moat score 0".
- Defaulting `moat.enabled` / `portfolio.enabled` ON for activated workspaces (issue AC#4, display-only) is
  governed by those features' own flags (#103/#107) and is deferred to a focused follow-up; this PR makes
  the stagnant stub *cannot consume budget* half true via the gate.
