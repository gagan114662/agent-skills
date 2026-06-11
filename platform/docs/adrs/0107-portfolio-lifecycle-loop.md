# ADR-0107 — Portfolio Lifecycle Loop

**Status:** Accepted
**Issue:** #107
**Date:** 2026-06-11

## Context

Premortem #8: every launched venture accrues liabilities (bugs, support, infra cost, security surface)
faster than revenue at first, and ten unmanaged launches become a maintenance graveyard. The Venture
Loop (#96) applies kill discipline to *ideas* — it KILLs the unfundable before any code is built — but
once an idea is FUNDed and launched, nothing ever revisits it. The venture wave that just landed
produced exactly the signals a portfolio review needs: growth (#102), moat + stagnation (#103), demand
evidence (#101), revenue (#98), and infra burn (#71 `tenant_usage`). What is missing is the loop that
reads those signals per launched venture and decides whether to invest more, hold, pivot, or sunset —
with the kill (sunset) gated for a human, and the lesson captured so the portfolio learns.

## Decision

Add a **portfolio-lifecycle** subsystem with the same pure-core + IO-orchestrator + config-caps shape
as #96/#103/#102:

1. **Pure decision (`portfolio/decide.ts`)** — `portfolioHealth` (a weighted 0–100 composite of
   growth, moat, and a bounded demand sub-score) and `decidePortfolio` (a deterministic ladder →
   `DOUBLE_DOWN` / `MAINTAIN` / `PIVOT` / `SUNSET` with reasons). No IO, no clock — `ageInDays` is
   passed in — so the whole core is unit-tested in isolation. The ladder encodes the kill discipline:
   a fresh launch gets a grace window; a low-health venture, or one **burning money with zero traction
   (no revenue, no demand)**, is a SUNSET; a stagnant-but-cheap venture with no traction is a PIVOT.
2. **A durable review ledger (`portfolio_reviews`, migration `0107_`)** — each review snapshots the
   evidence it decided on (growth/moat/demand/revenue/cost/age), the decision, the reasons, and the
   SUNSET approval link + lifecycle status. The ledger is the audit trail; the dashboard is a
   projection of it. Workspace-scoped (`onDelete: cascade`), `venture_idea_id` FK cascade.
3. **A read API + gated lifecycle (`PortfolioService`)** the Founder Console (#104) and the dashboard
   route consume — `reviewPortfolio` / `listReviews`, and the SUNSET lifecycle `requestSunset` /
   `executeSunset`. Seam-injected so it unit-tests against fakes.
4. **Sunset is approval-gated (#13).** `portfolio.sunset` is added to `DEFAULT_SENSITIVE_ACTIONS`
   exactly like `autonomy.complete` (#84/ADR-0042) and `dr.restore` (#99): never submitted through the
   #13 *action route*, but evaluated against the same workspace `approval_policies` so a kill is
   human-gated by default (an agent can never approve its own gate — ADR-0013) and a workspace can opt
   out with one rule. Only after approval does `executeSunset` write the post-mortem and flip the idea
   `killed`.
5. **Lessons compound (#15).** On `executeSunset` the reasoning is written to the memory graph
   (`upsertMemory`, type `decision`, `entity = ventureIdeaId`, dedupe `portfolio:sunset:<ideaId>`,
   `sourceType = "event"` — within the `memories_source_type_ck` set `message|task|file|event|manual`,
   the `portfolio_sunset` discriminator lives in `content`) — mirroring the existing #96 KILL→memory
   path so the next venture inherits the lesson.
6. **Founder Console surface (#104) + a dashboard route.** The Console gains an optional `portfolio`
   pane (decision counts + an attention reason when sunsets await approval); `GET /workspaces/:wid/portfolio`
   returns the full per-venture dashboard (decision, KPIs, burn, net economics).

The loop is **default OFF** (`portfolio.enabled: false`): a deployment that sets no `portfolio` block
keeps today's behavior. Computing/persisting/listing reviews always work (read-mostly surfaces); only
the Console *attention* posture is gated, mirroring how #103 keeps recording always-on while gating the
flag. SUNSET execution is **always** approval-gated regardless of `enabled`.

## Alternatives considered

- **Persist per-venture targets at FUND time and review against them.** The issue frames the review as
  "against targets set at FUND time," but #96 stores no success-target on FUND. Rather than retrofit a
  target column onto the venture schema (a change to a stable, well-tested subsystem), the review uses
  the **tenant policy thresholds** as the target — a per-workspace, layered, lockable target (#58),
  which is what a target *is*. Each review row snapshots the evidence so it remains auditable against
  the threshold that applied. A per-venture target override is a natural follow-up on this ledger.
- **Automate the full sunset playbook (notify users, export data, refund, tear down infra).** Rejected
  for this slice: those steps are operational and partly already gated (refunds are `billing.refund`,
  #13-gated). Automating teardown is exactly the kind of irreversible action that must not be
  agent-initiated. This slice ships the decision, the human gate, the post-mortem, and the `killed`
  flip; it surfaces the rest as recommendations.
- **Fold the decision into the #96 decide gate.** Rejected: #96 decides *fundability at intake*; the
  portfolio loop decides *continued investment post-launch*. Different inputs (live KPIs vs intake
  evidence), different cadence (periodic vs one-shot), different action (sunset vs kill-idea). Keeping
  them separate keeps #96's tests untouched; a PIVOT re-enters #96 through the existing `submit` path.
- **A single magnitude (revenue only) decision.** Rejected: revenue alone sunsets every pre-revenue
  launch in its grace window. The composite (growth + moat + demand) plus the burn/traction economics
  matches the premortem — liabilities outrun revenue *at first*, so the loop must read leading signals,
  not just the lagging one.

## Numbering

ADR + migration + spec numbered **0107 / 107** (by issue), not next-sequential, to dodge collisions
with sibling Conductor branches landing migrations in parallel — the same discipline as
#99/#103/#112/#117.

## Consequences

- One new additive table; `.down.sql` drops it. No change to existing schema.
- New `portfolio` config block — **must** appear in both `mergeSettings` and `mergeLayers` (a block in
  only one is silently dropped at runtime; the #98/#103 gotcha).
- New sensitive action `portfolio.sunset` — additive to `DEFAULT_SENSITIVE_ACTIONS`; no existing
  action's gating changes.
- The Founder Console gains an optional `portfolio` input; absent ⇒ a zeroed portfolio view (works
  before the subsystem is wired, like the #103 moat pane).
- `reviewPortfolio` is a callable tick; no scheduler is added (downstream, like #103 → #107 itself).
