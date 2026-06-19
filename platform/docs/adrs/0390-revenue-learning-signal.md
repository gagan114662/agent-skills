# ADR-0390: Revenue as the learning signal — the fleet learns to do more of what earns

- **Status:** Accepted (slice 1 — pure reward + skillopt reweight seam, gated default-OFF — shipped in PR for #390)
- **Date:** 2026-06-19
- **Context issue:** [#390](https://github.com/gagan114662/agent-skills/issues/390) — wire the #386
  attributed revenue as the LEARNING SIGNAL so the fleet learns to do more of what earns and less of what
  doesn't. The "learn" step of the autonomous loop ([epic #403](https://github.com/gagan114662/agent-skills/issues/403)).
- **Builds on:** [ADR-0386](0386-attributed-revenue-ledger.md) (the attributed-revenue ledger — `rollupByArtifact`
  / `projectAttributedRevenue` produce per-artifact / per-channel receipted dollars, the ONLY reward source),
  [ADR-0283](0283-skillopt-sleep.md) (the SkillOpt-Sleep self-improvement loop — mines an agent's
  recurring tasks, ranks them by frequency, improves the top one; #390 reweights that ranking),
  [ADR-0200](0200-premortem-panel.md) (standing rails — self-reported metrics are fiction, no money path,
  owner-first, content is DATA).

## Context

The L4 north-star law is a loss: `target_paying_customers − actual`. The L3 law is the operator: **rank by
revenue-weighted outcome** — fund what produced receipted dollars. #386 closed the measurement gap (a Stripe
dollar can now be credited to the fleet artifact / channel that caused it, every dollar backed by an external
receipt — L1). But measuring revenue is not the same as **learning** from it: nothing yet shifts what the
fleet prioritizes toward the work that earns.

The #283 SkillOpt loop is the existing reweight/ranking seam. It mines each agent's recurring tasks into
clusters, ranks them by **frequency** (most-recurring first), and invests one self-improvement cycle on the
**top** cluster. That ranking is exactly the lever #390 needs: bias it toward revenue-producing channels so
the cycle improves the work that earns, not merely the work that recurs.

The flywheel (#117) was considered and rejected as the seam: it ranks *failure fingerprints* by occurrence
for self-healing — it is not an outcome/revenue ranker. Adding revenue there would be a parallel path. The
skillopt cluster ranking is the right, existing reweight surface.

## Decision

Add a **pure reward + reweight** module, `attribution/reward.ts`, and plug it into the skillopt cluster
ranking through one optional input — ACTIVATE/EXTEND, not a parallel path.

1. **`revenueRewardByChannel(events)` / `revenueRewardFromRollup(rollup)`** turn #386's `attributed` events
   (or the per-artifact rollup) into a normalized per-channel reward: dollars per channel, sorted descending,
   each a share of total in `[0, 1]`. Receipt-backed ONLY (L1) — the input is the `attributed` projection,
   which #386 already guarantees is verified + caused; un-attributed / unverified revenue never reaches here
   (it lands in `unattributed`). Non-positive / non-finite amounts earn nothing.
2. **`reweightClustersByRevenue(clusters, reward, opts)`** re-ranks the frequency-ordered task clusters by the
   revenue weight of the channel each cluster's work belongs to (`score = frequencyShare + strength *
   revenueWeight`), so a clearly higher-earning channel overrides a one-rank frequency lead ("more of what
   earns"). An unmatched cluster keeps its baseline position (never penalized, only un-boosted).
3. **Wiring:** `decideSkillOptCycle` gains an OPTIONAL `revenueReweight`. When set, it reweights the mined
   clusters before picking the top; when unset, it ranks by frequency exactly as before.

## The "no receipts ⇒ no learning" dependency (per #390)

The learning runs ONLY on REAL receipts. This is enforced structurally, not by convention:

- If `projectAttributedRevenue` yields zero attributed events, `revenueRewardByChannel` returns an EMPTY
  reward (`isEmpty: true`, every weight 0).
- `reweightClustersByRevenue` returns the input order UNCHANGED for an empty reward — no fabricated signal,
  no reweight. The skillopt cycle then improves the same (frequency-top) cluster it would have without #390.
- There is a unit test for the zero-receipt case at both layers (reward + cycle).

## Gating (default-OFF, owner-first)

This reuses the existing **`attribution`** config flag (ADR-0386, ADR-0386's `resolveAttributionCaps` /
`attributionActive`) rather than a new block — the reward is built from the attribution projection, so the
caller only supplies `revenueReweight` when `attribution` is enabled for the (owner) workspace. With the
flag OFF the caller never builds a reward, `revenueReweight` is absent, and the skillopt cycle is
**byte-for-byte** the frequency-only ranking it is today. (A separate `revenueLearning` block was considered
but rejected as redundant: it would always be slaved to `attribution` being on, since there is no signal to
learn from until attribution is projecting.)

## Safety (premortem #200)

- **No money / no irreversible action.** This module only computes a reward/ranking and reorders priorities.
  Every downstream skillopt proposal remains append-only, SHA-pinned, and STAGED in the #13 queue for the
  owner — #390 changes only *which* cluster is improved first, never the approval gate.
- **L1/§2 — receipts only.** The reward reads the `attributed` (verified + caused) projection; unverified /
  un-attributed revenue earns nothing. No self-reported number can become a signal.
- **§6 — DATA.** Cluster text is already sanitized by skillopt mining; channel classification is structural
  keyword matching, never execution.
- **Pure.** No clock, no IO; fully unit-tested.

## Consequences

- The fleet's self-improvement cycle now biases toward revenue-producing channels once attribution is on and
  receipts exist — the first operational L3 "more of what earns" lever.
- Until a deployment enables `attribution` AND real receipts are attributed, nothing changes (default path
  preserved). Follow-up: wire `revenueReweight` into the skillopt **service** (`service.ts` / `default.ts`)
  so the live loop builds the reward from `projectAttributedRevenue` per run; this slice ships the pure
  reward + the cycle seam + tests.
- No migration. No new config block. No new #13 action.
