# ADR-0100: Insight Miner — Evidence-Sourced Secrets feeding the Venture Loop SOURCE stage

- **Status:** Accepted (owner waived the video gate — issue #100)
- **Date:** 2026-06-11
- **Context issue:** [#100](https://github.com/gagan114662/agent-skills/issues/100) (Phase 5 — a
  better SOURCE stage for the 24/7 venture fleet)
- **Builds on:** [ADR-0049](0049-venture-loop.md) (the Venture Loop: typed idea intake
  `VentureService.submit`, pure `decide` + IO orchestrator shape), [ADR-0017](0017-autonomy.md)
  (autonomy kill switch), [ADR-0040](0040-cloud-scale.md) (tenant usage accounting + budget cap),
  [ADR-0035](0035-config-layering.md) (managed/per-tenant config). Defers: live web scraping /
  changelog crawling / LLM pain analysis (the `Miner` seam).

## Context
Premortem #3 of the venture program: an LLM emits the **median of public knowledge** — consensus
ideas, not secrets. The Venture Loop (#96) scores and gates ideas, but it is only as good as the
ideas it is fed. If intake is brainstormed, the loop polishes consensus. The fix is to ground intake
in **asymmetric, time-sensitive evidence** — repeated cited pain, why-now deltas incumbents have not
absorbed, and the owner's proprietary observations — and to spend scarce mining budget on the
**highest-evidence sources first** ("the list is the strategy": score the list before you work it).

## Decisions

1. **An `insight/` module mirroring the #96 `venture/` shape: pure core + IO orchestrator + thin
   route.** `ranking.ts` and `dedupe.ts` are **pure** and are the single source of truth for how
   sources/insights are scored and how killed angles are suppressed — no IO, fully unit-tested.
   `service.ts` (`InsightMiner`) is the IO orchestrator; `routes/insights.ts` is a thin
   `requireIdentity` + `assertWorkspace` adapter. Every collaborator (the miner, the venture-idea
   creator, the memory dedupe checker, usage, kill switch) is an injected seam.

2. **"List is the strategy": rank sources before mining them.** `rankSource(kind, observedAt)` =
   **kind authority × freshness** (an exponential recency decay). Owner-secret sources rank highest
   (the only *true* secret); primary cited sources (support forums, reviews, communities) rank above
   secondary why-now signals (changelogs, pricing pages). The miner works the candidate list in
   descending `evidence_strength`, cut at a configurable `minSourceStrength`.

3. **Insights rank multiplicatively: freshness × pain intensity × competition absence.** Each factor
   is normalised to 0–1 and the product scaled to 0–100, so **a zero on any axis zeroes the insight**
   — a stale, painless, or crowded insight cannot rank highly no matter how strong the other two
   axes. This is deliberately harsher than an average: an asymmetric secret must win on *all three*.

4. **Killed angles never return uncited (memory-graph dedupe).** The venture loop records KILL
   verdicts to the #15 memory graph. Before promoting an insight, `suppressedByKill` checks whether
   the insight's dedupe key matches a recorded kill **and the insight is uncited** (no sourced
   evidence). A killed angle that now carries a *real citation* is allowed back — the whole point is
   to let **new evidence** reopen a question, while blocking the LLM from re-proposing the same
   uncited consensus idea the loop already rejected. The dedupe key reuses #15's `dedupeKey` so the
   same statement resolves to one node regardless of source.

5. **Owner-secret intake is first-class and ungated.** Gagan's proprietary observations are captured
   directly as `owner_secret` insights with no kill-switch/budget gate (no agent session is used) and
   no required external citation (the observation *is* the source). They rank with maximal freshness
   and feed the same promotion path.

6. **Mining is the only gated path — and it reuses the venture loop's exact seams.** `mine` (the
   agent-session path that scrapes/analyses sources) **skips when the #17 kill switch is engaged** and
   **skips when the #71 tenant budget is exhausted**, charging `mineCostCents` to the SAME
   `tenant_usage` window + the SAME `budgetExceeded(spent, scale.budgetCents)` cap that bounds session
   and venture spend. One tenant budget bounds sessions, ventures, and mining together — the same hard
   stop halts all three.

7. **Insights become venture ideas with provenance.** `promote` calls `VentureService.submit` (#96
   SOURCE) and persists the **`promoted_idea_id`** link on the insight; the insight's evidence rows
   (source URLs + recency) are the provenance trail. The idea's `insight` field carries the secret;
   the caller supplies the remaining framing (target user, wedge, market path).

8. **Tenant isolation + config default-OFF.** All three tables are `workspace_id`-scoped with
   `ON DELETE CASCADE`; the route enforces the #19 `assertWorkspace` boundary. The `insight` config
   block defaults to `enabled: false` and the background tick is opt-in (`INSIGHT_INTERVAL_MS`,
   default 0), so a deployment that sets nothing keeps today's behavior.

## Consequences
- **Positive:** intake is grounded in scored evidence with provenance; scarce mining budget goes to
  the strongest sources first; killed angles cannot return as uncited consensus; owner secrets are
  first-class; mining shares the venture loop's kill-switch + budget governance; the pure ranking and
  dedupe make every required path a fast unit test; default-OFF means zero behavior change until
  opted in.
- **Negative / deferred:** the shipped miner is a deterministic stand-in — real web scraping,
  changelog/regulation crawling, and LLM pain analysis are follow-ups (the ranking, persistence,
  dedupe, gating, promotion, and tick are real). Competition-absence and pain-intensity are operator-
  /miner-supplied scalars in v1; deriving them from raw evidence volume is a follow-up.

## Alternatives considered
- **Average the three ranking axes instead of multiplying.** Rejected: an average lets a strong pain
  score paper over a stale or crowded space — exactly the consensus-idea failure mode. Multiplication
  forces a secret to win on all three axes.
- **Suppress every killed angle unconditionally.** Rejected: that would permanently freeze a question
  even when fresh evidence emerges. Gating suppression on *uncited* preserves the "new evidence may
  reopen it" path while still blocking uncited re-proposals.
- **A separate mining budget.** Rejected for v1, consistent with #96: mining reuses the existing
  tenant-usage accounting and the same 402-style exhaustion, so all autonomous spend draws from one
  tenant budget.
