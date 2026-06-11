# ADR-0115: Product Planning Loop — feedback + metrics → RICE-ranked backlog → specs → agent sessions

- **Status:** Accepted (shipped in PR for #115)
- **Date:** 2026-06-11
- **Context issue:** [#115](https://github.com/gagan114662/agent-skills/issues/115)
- **Spec:** [docs/specs/115-product-planning-loop.md](../specs/115-product-planning-loop.md)
- **Builds on:** [ADR-0117](0117-self-healing-flywheel.md) (the infrastructure-time supervisor shape:
  opt-in tick, kill-switch / maintenance gating, durable bounded tables, pure `decide`/pure-rank + IO
  engine, #92 launcher reuse, #95 policy auto-approve, #13 queue, #71 dollar ceiling, #104 read
  surface), [ADR-0049](0049-venture-loop.md) (`ventureGatedLauncher` — a proposed build session clears
  the fundable-venture gate), [ADR-0042](0042-autonomy-real-sessions.md) / #84 (real sessions via the
  `AutonomyLauncher` seam; #95 policy auto-approve), [ADR-0040](0040-cloud-scale.md) (`tenant_usage`
  dollar ceiling), [ADR-0102](0102-growth-loop.md) (a backlog evidence source; #106 Outcome Verifier
  and #114 Customer Voice are forward-looking sources, wired when they land),
  [ADR-0050](0050-founder-console.md) (the read-only console surface),
  [ADR-0013](0013-approval-gates.md) (approvals queue), [ADR-0099](0099-disaster-recovery.md)
  (maintenance Redis flag + by-issue numbering).

> **Numbering note.** Spec/migration/ADR all use the `0115` slot (the issue number), per the project's
> by-issue numbering convention (see ADR-0099's note) — chosen to dodge sibling-workspace collisions in
> the shared migration sequence.

## Context

After v1 ships, the platform builds, ships, supervises, and heals itself — but **nothing decides what
to build next**. Agents polish whatever they were last told to instead of what users need; product
planning is still 100% founder labor. The platform already *collects* the evidence to decide — Customer
Voice insights (#114), Growth funnel metrics (#102), Outcome Verifier gaps (#106) — but it evaporates
into separate panes; nothing turns it into a prioritized, actionable backlog that flows to a build
session.

The hard parts are not "store a backlog" or "launch an agent" — the schema and #92/#96 already do
those. They are: (a) a **deterministic, defensible ranking** (RICE) derived from evidence so the order
is explainable, not vibes; (b) a **sensitive-by-default dispatch** so a planning loop can never
autonomously pivot the product or burn budget — pivots and over-budget efforts go to a human, only
small policy-allowed items auto-flow; (c) a **bounded, gated, default-OFF** tick (budget, kill switch,
maintenance) that reuses the #117 supervisor shape verbatim; (d) a **why-ranked-here** trail so the
owner can audit every ranking against its evidence.

## Decisions

1. **Mirror the #117 flywheel wholesale.** The planning loop is a third infrastructure-time supervisor,
   so it reuses #117's proven shape: an opt-in `tick` (default OFF), kill-switch + maintenance gating, a
   pure decision (`decide.ts`) + pure rank (`rice.ts`) + IO engine (`service.ts`) split, durable
   workspace-scoped tables, the #92 launcher seam, the #95 policy auto-approve, the #13 queue, the #71
   dollar ceiling, and the #104 read surface. New mechanism is minimized to the RICE math + the spec
   drafting.

2. **RICE as a pure module, derived from evidence counts.** `deriveRice(evidence)` maps counts to the
   canonical RICE inputs: Reach = distinct corroborating signals; Impact = a 0–4 severity tier mapped to
   the standard {0.25, 0.5, 1, 2, 3} multipliers; Confidence = a 0–100 corroboration percentage / 100;
   Effort = the agent estimate (≥ 1). `scoreRice` = (R × I × C) / Effort. `rankBacklog` sorts desc,
   stable, ties by recency. Persisting the **inputs** (not the score) keeps the pure module the single
   source of truth — the console + routes compute the score off the same scorer (the #102 "score is
   always derived, never persisted" discipline).

3. **Sensitive-by-default dispatch (route-first).** `decidePlanningDispatch` decides the route before
   any spend cap, because queueing a human consumes no session slot and no budget: a **pivot** gates, an
   **over-budget effort** (effort above `autoEffortCeiling`) gates, a class **not** #95-auto-allowed
   gates; only then do the spend caps bite the **auto path** — kill switch / budget exhaustion **skip**
   (retry next tick), everything else **auto-dispatches**. This is the #117 `decideDispatch` precedence,
   extended with the pivot + effort-ceiling gates the issue names. Default-OFF means no #95 rule exists,
   so **everything queues** until an operator explicitly opts a class in.

4. **Dispatch through the venture-gated launcher (#96).** The `SpecDispatcher` default adapts
   `ventureGatedLauncher(autonomyLauncherFrom(sessionManager), createVentureAdmission())`, so a proposed
   build session first clears the fundable-venture admission gate — the planning loop can never spend a
   session on a venture that has not earned it. The gate short-circuits to admit when `venture.enabled`
   is off, so wiring it is safe for every workspace.

5. **Soft references, workspace-scoped, durable + bounded.** Every cross-entity link (`idea_id`,
   `source_ref`, `target_*`, `spec_id`, `session_id`, `approval_request_id`, `backlog_item_id`) is a
   soft reference (no FK); only `workspace_id` cascades. Reads are `LIMIT`-bounded. This is the #117/#102
   persistence discipline — a backlog record outlives a pruned idea / member / approval.

6. **Default-OFF, managed-owned.** `planning.enabled` defaults false; the background interval
   (`PLANNING_INTERVAL_MS`) defaults 0. The config block is replace-merged so the managed layer owns the
   flag (cannot be loosened by a lower layer). Recording items + reading the ranked backlog are always
   available (harmless, tenant-scoped); `enabled` gates only the proactive tick.

## Consequences

- **Positive:** product planning becomes a measured, auditable loop instead of founder labor; rankings
  are explainable (why-ranked-here evidence links); the loop can never autonomously pivot or overspend
  (sensitive-by-default + venture gate + budget + kill switch); the implementation is almost entirely
  composed from proven #117/#96/#95/#13/#71/#104 seams.
- **Negative / deferred:** evidence emitters (#114/#102/#106 readers) are one-line `addItem(...)` adds
  left as follow-up; launch-on-approval automation is deferred (a queued #13 surfaces in the console);
  effort is an estimate input, not yet model-derived. None block the loop; each is an additive seam.
- **Risk:** a mis-tuned `autoEffortCeiling` or an over-permissive #95 rule could auto-dispatch too
  eagerly — bounded by the venture gate + the #71 budget + the kill switch, and visible read-only in the
  #104 console. Default-OFF means the risk is opt-in.
