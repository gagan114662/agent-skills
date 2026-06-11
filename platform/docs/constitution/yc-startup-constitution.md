# The YC Startup Constitution

> Adopted by issue #146 as **enforced decision criteria**, not a prompt preamble.
>
> The way Claude has a constitution that constrains its behaviour, the autonomous venture
> fleet has this one. Each Article is a principle drawn faithfully from the Y Combinator
> canon (Sam Altman's *Startup Playbook*, Paul Graham's essays, the YC pricing curriculum).
> Every Article is mapped below to the **code** that enforces it — a file path you can open,
> not an aspiration. Where the enforcing system did not yet exist, issue #146 built it (the
> rows marked **NEW (#146)**).
>
> **These are heuristics, not physics.** Every enforcement path *flags and escalates* to the
> owner. None silently auto-corrects a decision. A human always has the final say.

## The eight Articles

### Article I — Make Something People Want (the love paradigm)
> "It's better to have a small number of users love you than a large number like you."
> — Sam Altman, *Startup Playbook*, Part I; cf. Paul Graham, *Be Relentlessly Resourceful*.

A venture earns the right to be funded by **evidence that real, unaffiliated people want the
product badly enough to act** — not by a persuasive pitch. For B2B ventures specifically,
"want" means buyers outside the building signalling paying intent. Synthetic enthusiasm (our
own personas) is not evidence.

**Enforced by:** the love-paradigm FUND gate (`constitution/love-gate.ts`) — a B2B venture
cannot pass FUND without ≥10 unaffiliated paying-intent signals; the verdict is downgraded to
ESCALATE and flagged. Backed by the #101 demand rails as the evidence source.

### Article II — Default Alive, Not Default Dead
> "Whether you're default alive or default dead … you should know which one you are."
> — Paul Graham, *Default Alive or Default Dead*.

Know, for every venture, whether on current trajectory it reaches profitability before it
runs out of money. A venture that is default dead with no plan must be fixed, pivoted, or
killed — kill discipline is a feature, not a failure.

**Enforced by:** the venture KILL verdict (#96, `venture/decide.ts` — a score at/below the
kill threshold terminates the venture and records the angle to memory) and the dollar-ceiling
budget caps (`scale/caps.ts`, `scale/usage.ts`) that stop spend on a default-dead trajectory.
The dedicated portfolio kill ladder (#107) deepens this when it merges.[^siblings]

### Article III — Talk to Your Users and Iterate
> "Talk to users and build something they want." — Sam Altman, *Startup Playbook*;
> cf. Paul Graham, *Do Things that Don't Scale* (§"Consult").

Decisions follow evidence gathered from real users, not opinion. The loop is
build → measure → learn, repeated, with explicit termination.

**Enforced by:** the venture iteration log (#96, `venture/service.ts` — every pass records
evidence + a gap list and never re-runs a failed angle) and the externally-attributed demand
evidence the loop consumes (#101, `demand/service.ts`). The dedicated Customer Voice Loop
(#114) deepens this when it merges.[^siblings]

### Article IV — Do Things That Don't Scale
> "Startups take off because the founders make them take off … the most common unscalable
> thing founders have to do at the start is to recruit users manually."
> — Paul Graham, *Do Things that Don't Scale*.

Early user acquisition is **manual and founder-led** (the Collison-install: personally set the
product up for your first users). The fleet must be able to draft this hand-to-hand outreach —
and every send still passes the human approval gate.

**Enforced by:** the unscalable-ops fleet task templates (`marketing/blueprint.ts`,
`UNSCALABLE_OPS_TEMPLATES`) — manual-first acquisition briefs whose agents hold only draft
tools; all external sends route through the #13 `external.send` approval gate.

### Article V — Don't Fool Yourself: Measure Real Growth
> "Don't fool yourself … growth that comes from real users." — Sam Altman, *Startup Playbook*;
> cf. Paul Graham, *Default Alive or Default Dead* (real, organic growth).

Numbers must be real and externally attributable. Vanity metrics and self-generated signals
do not count. A funding decision made on synthetic demand alone is a constitutional smell.

**Enforced by:** the Outcome Verifiers (#106, `verifiers/`) and the #101 demand rails
(`demand/provenance.ts` — only externally-attributed evidence can move the scorecard). The
constitution scorer flags a FUND made with no externally-attributed demand evidence.

### Article VI — Be Relentlessly Resourceful; Big Market, Focus, Intensity
> "Have a great idea, … in a big market, with a real competitive advantage."
> — Sam Altman, *Startup Playbook*, Part I.

A fundable venture clears an adversarial bar: a credible large-market path, a real wedge, a
defensible advantage — scored by two independent personas, not one optimistic voice.

**Enforced by:** the venture scorecard + adversarial dual-persona gate (#96, `venture/rubric.ts`,
`venture/decide.ts`) and the Growth Loop funnel scoring (#102, `growth/`).

### Article VII — Spend Like You're Poor
> "Spend like you're poor … the single best thing you can do is to keep your burn rate low."
> — Sam Altman, *Startup Playbook*, Part III (Execution / Finance).

Burn is bounded. Autonomous spend stops at a hard dollar ceiling, and projected infra-cost
breaches are surfaced before they happen.

**Enforced by:** the tenant-usage dollar ceilings (`scale/usage.ts`, `scale/caps.ts`), the
perf budget gates (`perf/budgets.ts`), and the Founder Console cost forecast that surfaces a
projected infra-ceiling breach before it lands (`founder-console/aggregate.ts`). The dedicated
#108 production cost-ceiling runbook deepens this when it merges.[^siblings]

### Article VIII — Charge Money, Then Raise Prices
> "Most founders charge too little … raise your prices." — YC *Pricing 101* /
> *A Guide to Pricing Strategy*.

Charge real money, and treat pricing as an experiment: raise prices in disciplined increments
until deal-loss reveals the ceiling — but a price change is **always a proposal for a human**,
never an autonomous action.

**Enforced by:** Evidence-Priced Autonomy (#119, `gate-pricing/`) and the 10/5/20 pricing
ladder (`constitution/pricing-ladder.ts`) — proposes price increments, flags when deal-loss
exceeds 20%, and only ever produces an approval-gated proposal.

---

## Coverage map — Article → enforcing system → file paths

Every Article maps to running code. Rows marked **NEW (#146)** were built by this PR; the rest
predate it and are wired into the same constitution scorer so violations are detected uniformly.

| Article | Principle | Enforcing system(s) | File paths |
|---------|-----------|---------------------|------------|
| **I** | Make something people want (love > like) | **Love-paradigm FUND gate (NEW #146)** + #101 demand rails | `apps/server/src/constitution/love-gate.ts`, `apps/server/src/demand/provenance.ts`, `apps/server/src/demand/signals.ts` |
| **II** | Default alive, kill discipline | #96 venture KILL verdict + dollar-ceiling budget caps (#107 portfolio deepens, sibling) | `apps/server/src/venture/decide.ts`, `apps/server/src/scale/caps.ts`, `apps/server/src/scale/usage.ts` |
| **III** | Talk to users & iterate | #96 iteration log + #101 demand evidence (#114 voice deepens, sibling) | `apps/server/src/venture/service.ts`, `apps/server/src/demand/service.ts` |
| **IV** | Do things that don't scale | **Unscalable-ops fleet templates (NEW #146)** + #123 marketing fleet | `apps/server/src/marketing/blueprint.ts`, `apps/server/src/marketing/external-send.ts` |
| **V** | Don't fool yourself — real growth | #106 outcome verifiers + #101 demand rails | `apps/server/src/verifiers/`, `apps/server/src/demand/provenance.ts` |
| **VI** | Big market, focus, adversarial bar | #96 venture scorecard + #102 growth loop | `apps/server/src/venture/rubric.ts`, `apps/server/src/venture/decide.ts`, `apps/server/src/growth/` |
| **VII** | Spend like you're poor | dollar ceilings + perf budgets + cost forecast (#108 runbook deepens, sibling) | `apps/server/src/scale/usage.ts`, `apps/server/src/perf/budgets.ts`, `apps/server/src/founder-console/aggregate.ts` |
| **VIII** | Charge money, raise prices | #119 evidence-priced autonomy + **10/5/20 pricing ladder (NEW #146)** | `apps/server/src/gate-pricing/`, `apps/server/src/constitution/pricing-ladder.ts` |

[^siblings]: Issue #146 names #107 (portfolio lifecycle), #114 (customer voice loop), and #108
    (production cost-ceiling runbook) as the eventual owners of Articles II / III / VII. Those land
    in sibling branches not yet merged to this base, so the rows above anchor to the enforcing code
    that **does** exist on this branch today; the named systems deepen each Article when they merge.
    This keeps the map auditable (every path resolves) rather than aspirational.

### The constitution scorer (cross-cutting)

Every venture **SOURCE / FUND / KILL** decision is scored against the Articles by a pure,
deterministic module and any violations are recorded, escalated, and logged:

| Concern | File |
|---------|------|
| Article registry (this doc, as data) | `apps/server/src/constitution/articles.ts` |
| Deterministic decision scorer | `apps/server/src/constitution/scorer.ts` |
| Love-paradigm FUND gate (Article I) | `apps/server/src/constitution/love-gate.ts` |
| 10/5/20 pricing ladder (Article VIII) | `apps/server/src/constitution/pricing-ladder.ts` |
| Violation persistence (durable feed) | `apps/server/src/db/schema/constitution.ts`, `apps/server/src/db/repositories/constitution.ts` |
| Venture-loop integration | `apps/server/src/venture/service.ts` |
| Owner attention surfacing | `apps/server/src/founder-console/aggregate.ts` |
| Repeated-violation → issue (flywheel) | `apps/server/src/flywheel/` (`constitution_violation` failure class) |
| Observability (Braintrust) | `apps/server/src/observability/constitution-log.ts` |

**Default OFF.** The whole apparatus is gated by the `constitution` config block
(`enabled: false` by default). A deployment that sets nothing keeps today's behaviour exactly.
