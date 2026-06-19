# ADR-0386: Attributed-revenue ledger — credit a fleet artifact for the Stripe dollar it caused

- **Status:** Accepted (slice 1 — pure attribution core + schema + config — shipped in PR for #386)
- **Date:** 2026-06-19
- **Context issue:** [#386](https://github.com/gagan114662/agent-skills/issues/386) — ipop has earned $0.
  The only metric on the wall ([ipop-north-star.md](../../../ipop-north-star.md): "paying customers ipop
  acquired through its own fleet. Target: 1") is still zero. The revenue *machinery* (Stripe webhook #98,
  monetization #188, finance ledger #194, demand validation #101) was built and closed, but the pieces are
  separate islands: nothing ties a Stripe receipt back to the fleet artifact that caused it. So the fleet
  can neither prove which work earned a dollar nor learn from it (the loss function in #390/#283 has no
  signal). This is the keystone gap.
- **Builds on:** [ADR-0101](0101-demand-validation-rails.md) (the `ExternalDemandEvidence` provenance brand
  — self-generated "payment" is unconstructable; #386 routes the `paid` apex through it),
  [ADR-0043](0043-stripe-revenue-rails.md)/#98 (the signature-verified Stripe webhook → `revenue_events`,
  the only verified receipt source — reused, not rebuilt), [ADR-0194](0194-finance-ledger.md) (the
  `verified`/`verifiedShareBps` "no metric without a receipt" discipline), [ADR-0200](0200-premortem-panel.md)
  (standing rails — content is DATA, no money path, owner-first).

## Context

The north-star unit is the **attributed revenue event**: a causal chain
`fleet artifact → exposure → signup → payment`. Value flows by **happened-before causality** (L2): an
artifact is credited for a dollar only if its exposure preceded the payment. Every credited dollar is
backed by an **external receipt** (L1): an unverified "payment" earns nothing. Artifacts are ranked by
**revenue-weighted outcome** (L3): fund what produced receipted dollars, not impressions.

Before this change nothing minted a tracking identity, stamped it on an outbound artifact URL, recovered it
on the inbound visit, or joined the exposure to the verified receipt. The Stripe charge could not be traced
to the artifact that caused it.

## Decision

Add a new, **default-OFF, owner-workspace-first** `attribution` module that is the edge graph between the
existing exposure-capture (demand funnel) and the existing verified receipt (`revenue_events`). It adds
**no money path** — it only projects credit over receipts that already exist.

**Slice 1 (this PR) — the pure core + persistence schema + config flag:**

- `attribution/tracking.ts` — `mintTrackingRef` (deterministic content hash of workspace+artifact+channel,
  so re-stamping is idempotent and an exposure is re-derivable), `buildTrackedUrl` (UTM + `ref` stamping,
  never corrupts a non-URL body), `recoverTrackingRef` (returns the ref only if it carries ipop's prefix —
  a foreign `?ref=` is ignored).
- `attribution/chain.ts` — `attributeRevenue` credits each verified receipt to the EARLIEST exposure on its
  ref, rejecting unverified receipts, missing refs, backward causality, and stale chains; `rollupByArtifact`
  ranks artifacts by receipted cents (L3); `paidEvidenceFromReceipt` builds the `paid` apex through the
  #101 `ExternalDemandEvidence` brand (so self-generated payment is unconstructable here too).
- `attribution/caps.ts` — `resolveAttributionCaps` (default OFF, fail-closed owner gate: named-nobody =
  nobody), `attributionActive`, `maxChainAgeMs`.
- `attribution_exposures` table (migration `0386`, numbered by issue per ADR-0099) — the one net-new row:
  an exposure (artifact_id, artifact_kind, tracking_ref, channel, occurred_at), deduped on
  `(workspace, tracking_ref)`. The signup side already persists as a #101 demand signal; the payment side
  as a #98 `revenue_events` row.
- Config block `attribution` (the 5+2+1 pattern): schema + root registration + ResolvedConfig +
  CONFIG_DEFAULTS + type export (5); layers replace-merge + default fill (2); loader
  `RELOAD_ATTRIBUTION_ENABLED` / `RELOAD_ATTRIBUTION_OWNER_WORKSPACE_ID` env opt-in (1).

**Next slice (follow-up, owner-gated):** the DB-backed store + service that records exposures at artifact
ship-time, recovers the ref on a live landing visit (web/route wiring), folds attributed revenue into the
finance ledger via the existing `VentureAttributor`/`RevenueEventReader` seams, and renders the causal chain
on the board. Flipping it live (the env flag + the owner naming their workspace) stays an owner act.

## Rails (premortem #200)

- **Owner-workspace-first, default-OFF, fail-closed.** Prod with no `attribution` block is byte-for-byte
  unchanged: nothing is stamped, no projection runs.
- **No money path, no new action.** This module reads receipts and projects credit; it moves no money and
  adds nothing to the #13 queue. Money-out stays the only human gate (L5).
- **#200 §2 (no metric without a receipt):** an unverified receipt or a self-generated payment earns zero
  credit — enforced structurally via the #101 brand and the `verified` guard.
- **#200 §6 (untrusted content):** artifact ids / channels are sanitized free text at the write site; a
  recovered ref is validated by prefix and never executed.

## Consequences

- The fleet can, for the first time, name which artifact caused a real dollar — the precondition for the
  #390/#283 learning loop (loss = `target_paying_customers − actual`) to run on real signal.
- Reuses every existing receipt/provenance/ledger primitive; no parallel revenue path.
- The first real attributed dollar still requires a real external payer and the owner flipping the flag —
  this ADR builds everything up to that line.
