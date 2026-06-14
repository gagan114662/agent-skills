# ADR-0197: Venture memory & planning — the company remembers, learns, and plans across weeks

- **Status:** Accepted (shipped in PR for #197)
- **Date:** 2026-06-13
- **Context issue:** [#197](https://github.com/gagan114662/agent-skills/issues/197)
- **Premortem:** [#200](https://github.com/gagan114662/agent-skills/issues/200) — the standing list of
  reasons the company fails even if #187–#197 ship perfectly. The planning loop answers to it.
- **Builds on:** [ADR-0115](0115-product-planning-loop.md) (the supervisor shape copied wholesale:
  opt-in tick, kill-switch / maintenance gating, durable bounded tables, pure `decide` + IO `service`,
  #13 queue, #71 dollar ceiling, default-OFF replace-merged config), [ADR-0016] / #15 memory graph
  (`memories` table — venture memory reuses it, no new memory store), [ADR-0049](0049-venture-loop.md)
  (`ventureGatedLauncher`, the dual-persona scorecard, `Evidence{source}` = verified-vs-assumption),
  [ADR-0106](0106-outcome-verifiers.md) (`verifier_results` — the ONLY externally-verified metric tier
  the go/no-go trusts), [ADR-0172](0172-self-shipping-loop.md) / #115 dispatch (approved items become
  #115 backlog rows that auto-dispatch), [ADR-0173](0173-founder-briefings.md) (the weekly report +
  decision queue the plan lands in), [ADR-0099](0099-disaster-recovery.md) (maintenance flag + by-issue
  numbering).

> **Numbering note.** Migration + ADR use the `0197` slot (the issue number), per the project's
> by-issue numbering convention (ADR-0099's note) — to dodge sibling-workspace collisions in the shared
> migration sequence.

## Context

Sessions are goldfish — each starts nearly blank. A company compounds; it needs memory and a planning
rhythm that survives any single session. Today a venture's hard-won knowledge (what we decided and why,
what worked, what failed, what customers said, brand facts) evaporates when a session ends; the next
session re-derives it or contradicts it. And nothing decides what a venture should do *next week* — the
#115 planning loop ranks a workspace backlog but is venture-blind and has no weekly rhythm, no OKRs, no
cross-venture learning.

The premortem (#200) sharpens the hard parts. A planning loop that drafts from **self-reported** metrics
is drafting from fiction (#200 failure mode 2). A loop that decides go/no-go without citing the standing
failure list (#200 failure mode, AC3) is theater. So: estimates are labeled **UNVERIFIED**, the go/no-go
trusts **only** externally-verified (#106) metrics, and **every** go/no-go cites #200.

## Decisions

1. **Venture memory reuses the #15 `memories` table — no new memory store.** A venture memory is a
   `memories` row with `entity = venture:<ideaId>` (the label-match retrieval key), `type =
   venture_memory`, and a `kind` in `content` (`decision | worked | failed | customer_voice |
   brand_fact`). Retrieval is `listMemories(workspaceId, { entity, type })` — workspace-scoped (the #3
   tenant boundary) by construction. Dedupe rides the existing `(workspace_id, dedupe_key)` idempotent
   upsert; staleness/superseding rides the existing `supersedeMemory` + `includeStale`. The pure
   `composeVentureBrief` renders the retrieved set + OKRs into the text injected into a venture session.

2. **Mirror the #115 supervisor shape wholesale.** The weekly planning loop is another
   infrastructure-time supervisor: an opt-in `tick` (default OFF), kill-switch + maintenance gating, a
   pure `decideWeeklyPlan` + IO `service.ts`, durable workspace-scoped tables, the #13 queue, and the
   #104/#173 read surface. New mechanism is minimized to the plan-drafting math + the OKR drift + the
   playbook distillation.

3. **Honor the premortem in the plan, not just the prose.** `decideWeeklyPlan` is a pure function whose
   output *structurally* carries the premortem: `estimateLabel` is the literal `"UNVERIFIED"` on every
   item; `goNoGo` is `"no_go"` unless the venture has at least one externally-verified (#106) metric
   receipt — self-reported scorecard numbers never flip it to `"go"` alone; and `premortemCitation`
   names #200 with the specific failure modes the decision answers. The DB column `premortem_cited` is
   `NOT NULL DEFAULT true` and the drafter refuses to persist a plan without it.

4. **Approved items flow into the #115 backlog (reuse, don't rebuild dispatch).** A drafted plan lands
   as a **pending #13 request** (so it surfaces in the #173 decision queue the owner already reads).
   On approval, each plan item is inserted as a #115 `backlog_items` row (`source = manual`, `source_ref
   = venture-plan:<planId>`); the existing #115 loop ranks + dispatches it through the venture-gated
   launcher. The planning loop owns **drafting + the gate**; #115/#172 own dispatch. No new launcher.

5. **OKRs: 2–3 measurable objectives per venture, verified-aware drift.** `venture_okrs` stores
   objectives whose key results carry `{ metric, target, current, verified, source }`. Pure
   `computeOkrDrift` marks a key result `on_track | behind | unverified`: an **unverified** key result
   (no #106 source) can never read `on_track` — it is flagged, exactly as the scorecard distinguishes
   `Evidence{source}` from an assumption. Every venture session brief and the weekly report carry the
   OKRs + their drift flags.

6. **Cross-venture playbooks are anonymized + provenance-bearing, tenant-scoped.** `venture_playbooks`
   stores a reusable `pattern` (no venture-identifying text) plus `provenance` — a per-source-venture
   entry carrying a **hash** of the source venture id (so the owner can audit lineage without the
   pattern leaking which venture), the outcome, and the #106 verifier receipt that earned it. Playbooks
   stay inside the `workspace_id` boundary (#3): "cross-venture" means across one owner's ventures, never
   cross-tenant. Distillation only mints a playbook from an externally-verified win (#106) — an
   un-receipted "win" is not a pattern.

7. **Default-OFF, managed-owned, owner-workspace-first.** `ventureMemory.enabled` defaults false; the
   interval (`VENTURE_PLANNING_INTERVAL_MS`) defaults 0. The config block is replace-merged so the
   managed layer owns the flag. **Recording** venture memory + OKRs and **reading** beliefs/OKRs/plans
   are always available (harmless, tenant-scoped); `enabled` gates only the proactive weekly tick that
   drafts plans and distills playbooks.

8. **Soft references, workspace-scoped, durable + bounded.** `idea_id`, `approval_request_id`,
   `source_ref`, and the provenance `verifierResultId` are soft references (no FK); only `workspace_id`
   cascades. Reads are `LIMIT`-bounded. A memory/OKR/plan/playbook record outlives a pruned idea or
   approval — the #115/#117 persistence discipline.

## Consequences

- **Positive:** ventures compound — decisions/lessons/voice/brand survive any session and are retrieved
  into the next; planning becomes a weekly, owner-gated rhythm instead of founder labor; the go/no-go is
  premortem-bound and verified-metric-bound by construction, not by reviewer diligence; cross-venture
  wins become reusable, provenance-bearing patterns; OKR drift is surfaced in every brief. The
  implementation is almost entirely composed from proven #15/#115/#106/#13/#173 seams.
- **Negative / deferred:** owner *edits* to a plan are a reject-and-redraft today (the #13 gate
  approves/rejects; an edit API on the plan is an additive follow-up, not a new authority); the venture
  brief is injected at the venture-dispatch seam (the place venture build sessions are born) rather than
  by rewriting every `SessionManager.launch` caller — a documented, bounded seam; playbook *application*
  surfaces candidate patterns into the plan draft rather than auto-acting.
- **Risk:** a mis-tuned staleness window could surface stale beliefs, or a permissive #95 rule could
  auto-dispatch an approved item too eagerly — bounded by the verified-metric go/no-go, the venture
  gate, the #71 budget, the kill switch, and the owner #13 gate, all read-only-visible in #104/#173.
  Default-OFF means the risk is opt-in, owner workspace first.
