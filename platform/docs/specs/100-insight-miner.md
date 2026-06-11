# Spec: Reload Platform — Insight Miner: Evidence-Sourced Secrets, not Consensus Ideas (Issue #100)

> Implements [#100](https://github.com/gagan114662/agent-skills/issues/100). Phase 5 — feeding the
> **Venture Loop (#96)** a better SOURCE stage. **Builds on #96** (the YC-fundability gate: typed
> idea intake `VentureService.submit`), **#15** (memory graph: KILL verdicts recorded as decisions),
> **#17** (autonomy kill switch / `getControls`), **#71** (tenant-usage accounting + budget cap),
> **#58** (layered TOML config). Lifecycle: **DEFINE** artifact (`spec-driven-development`) → atomic
> plan → TDD. Out of scope: real web scraping / live API-changelog crawling / LLM analysis are behind
> injectable seams (the production wiring exists but is exercised against a deterministic stand-in
> miner; a live-research provider is a follow-up, exactly as #96 deferred its live evidence gatherer).

## Objective

**What:** Premortem #3 of the venture program — *LLMs emit the median of public knowledge (consensus
ideas), not secrets.* The Insight Miner fixes this by mining **asymmetric, time-sensitive evidence**
into structured **insights**, then promoting the strongest insights into Venture Loop ideas with
**provenance links** back to their sources. It follows the **"list is the strategy"** principle:
**score the sources before you mine them**, so scarce mining budget is spent on the highest-evidence
sources first.

Three intake modes (the issue's scope items 1–3):

1. **Pain mining** — niche communities, reviews, support forums analysed for **repeated, cited
   complaints**. Every mined insight carries **source URLs + recency** (no uncited pain).
2. **Why-now delta detection** — new APIs, regulations, pricing changes, model capabilities that
   incumbents have not absorbed yet (the time-sensitive asymmetry).
3. **Owner-secret intake** — structured capture of Gagan's proprietary observations as **first-class
   idea artifacts** (the only *true* secret source — it needs no external citation).

Plus scope item 4: **dedupe against the #15 memory graph** so an angle the venture loop already
**KILLed never returns uncited** — a killed angle may only re-enter if it now carries fresh citations.

**Ranking:** insights rank by **evidence freshness × pain intensity × competition absence**
(multiplicative — a zero on any axis zeroes the insight). Sources rank by **kind authority ×
freshness** before mining.

**Why:** The venture loop (#96) is only as good as its SOURCE stage. Brainstormed ideas are the
median of public knowledge; the moat is evidence the market has not yet priced in. The Insight Miner
is the SOURCE-stage upgrade that makes the whole loop produce secrets instead of consensus.

**Who:** Operators of the autonomous fleet who want the idea pipeline grounded in real evidence; a
founder (Gagan) whose proprietary observations become first-class artifacts; the venture loop, whose
intake now arrives pre-scored with provenance.

### Acceptance criteria (BUILD/TDD)

1. **Pure source ranking ("list is the strategy")** — `rankSource` scores a candidate source by kind
   authority × freshness (recency decay), deterministically, with no IO. Higher-authority + fresher
   sources rank first. Owner-secret sources rank highest (the true secret). Unit-tested.
2. **Pure insight ranking** — `rankInsight` = freshness × pain intensity × competition absence, each
   factor normalised to 0–1, the product scaled to 0–100. A stale insight, a painless insight, or one
   in a crowded space scores low; a fresh, acute, uncontested insight scores high. Unit-tested,
   boundaries included.
3. **Pure freshness decay** — `freshnessFactor(observedAt, now, halfLifeDays)` is a monotonic
   exponential decay in (0, 1]: today ≈ 1, one half-life ≈ 0.5, far past → 0. Unit-tested.
4. **Memory-graph dedupe (killed angles never return uncited)** — pure `suppressedByKill`: an insight
   whose dedupe key matches a recorded KILL is **suppressed iff it is uncited** (no sourced evidence);
   a killed angle that now carries a real citation is **not** suppressed. Unit-tested.
5. **Owner-secret intake is first-class and ungated** — `captureOwnerSecret` persists an insight of
   kind `owner_secret` with no kill-switch/budget gate (no agent session is used). Tenant-scoped.
6. **Mining is kill-switch + budget gated** — `mine` (the agent-session path that analyses sources)
   **skips when the #17 kill switch is engaged** and **skips when the #71 tenant budget is exhausted**
   (charging the per-pass cost against the same `tenant_usage` window the venture loop uses). Proven
   by unit tests with fakes (no DB, no model spend).
7. **Insights become venture ideas with provenance** — `promote` turns an insight into a #96 venture
   idea via `VentureService.submit`, persists the **`promoted_idea_id` link** on the insight and the
   insight's evidence rows as the provenance trail. A suppressed (killed-uncited) insight is **not**
   promoted (marked `duplicate`). Tenant-scoped.
8. **Tenant isolation** — every table is `workspace_id`-scoped with `ON DELETE CASCADE`; every repo
   and route enforces the #19 `assertWorkspace` IDOR boundary. Enabling the miner in workspace A never
   affects workspace B. Proven by an integration test.
9. **Config default-OFF** — the `insight` config block defaults to `enabled: false`; the background
   tick is opt-in (`INSIGHT_INTERVAL_MS`, default 0). A deployment that sets nothing keeps today's
   behavior (no mining, no spend).

## Design

A `insight/` module mirroring the #96 `venture/` shape: **pure core** (`ranking.ts`, `dedupe.ts`,
`caps.ts`) + **IO orchestrator** (`service.ts`) + **thin route** (`routes/insights.ts`) +
**production wiring** (`default.ts`) + **scheduled tick** (`engine.ts`). Every collaborator (the
miner, the venture-idea creator, the memory dedupe checker, usage, kill switch) is an injected seam,
so the service is unit-tested against fakes with no DB and no model spend.

**Persistence (migration `0100_insight_miner`):**
- `insight_sources` — the ranked candidate list (the "list is the strategy" surface): kind, url,
  title, `observed_at` (recency), computed `evidence_strength`, status (`candidate|mined|skipped`).
- `insights` — the structured insight: kind (`pain|why_now|owner_secret`), statement, `pain_intensity`
  (0–10), `competition_absence` (0–10), `freshness_at` (recency of strongest evidence), computed
  `score`, status (`mined|promoted|killed|duplicate`), `promoted_idea_id` (→ `venture_ideas`, the
  provenance link), `dedupe_key`.
- `insight_evidence` — provenance rows: `insight_id`, `source_url`, `excerpt`, `observed_at`, and an
  optional `source_id` back-reference. This is "every insight carries source URLs + recency".

**Gating (the agent-session path only):** `mine` reuses the venture loop's exact seams — the #17
`getControls().killSwitch`, the #71 `tenant_usage` meter + `budgetExceeded(spent, scale.budgetCents)`
cap, charging `mineCostCents` per pass. Owner-secret intake and source ranking are cheap/pure and
ungated. The miner itself (scrape + analyse) is a deterministic stand-in in `default.ts`; the live
provider is the deferred follow-up.

### Out of scope / deferred
- Real web scraping, live API-changelog/regulation crawlers, and LLM-backed pain analysis — behind
  the `Miner` seam (deterministic stand-in shipped), exactly as #96 deferred live evidence + the LLM
  persona scorer.
- A web UI for the source list / insight pipeline — the #104 Founder Console roll-up is a follow-up.
