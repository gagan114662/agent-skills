import type { Article, ArticleId } from "./types.js";

/**
 * The YC Startup Constitution as **data** (#146, ADR-0146). The committed prose
 * (`docs/constitution/yc-startup-constitution.md`) and this array are the same eight Articles; keeping
 * them as code means the scorer, the Founder Console, and any audit read the *same* source — the doc
 * and the enforcement cannot drift. Faithful summaries from the YC canon (Sam Altman's Startup
 * Playbook, Paul Graham's essays, the YC pricing curriculum).
 */
export const ARTICLES: readonly Article[] = [
  {
    id: "I",
    title: "Make something people want (love > like)",
    principle:
      "Earn the right to be funded with evidence that real, unaffiliated people want the product badly enough to act — not a persuasive pitch. For B2B, that means buyers outside the building signalling paying intent.",
    source: "Sam Altman, Startup Playbook (Part I); Paul Graham, Be Relentlessly Resourceful",
    enforcedBy: "love-paradigm FUND gate (constitution/love-gate.ts) + #101 demand rails",
  },
  {
    id: "II",
    title: "Default alive, not default dead",
    principle:
      "Know whether each venture reaches profitability before it runs out of money. Default dead with no plan must be fixed, pivoted, or killed — kill discipline is a feature.",
    source: "Paul Graham, Default Alive or Default Dead",
    enforcedBy: "#96 venture KILL verdict + dollar-ceiling budget caps (#107 portfolio deepens)",
  },
  {
    id: "III",
    title: "Talk to your users and iterate",
    principle:
      "Decisions follow evidence gathered from real users, not opinion. Build → measure → learn, repeated, with explicit termination.",
    source: "Sam Altman, Startup Playbook; Paul Graham, Do Things that Don't Scale (Consult)",
    enforcedBy: "#96 iteration log + #101 demand evidence (#114 voice loop deepens)",
  },
  {
    id: "IV",
    title: "Do things that don't scale",
    principle:
      "Early user acquisition is manual and founder-led — personally recruit and onboard the first users (the Collison install). Every external send still passes a human approval gate.",
    source: "Paul Graham, Do Things that Don't Scale",
    enforcedBy: "unscalable-ops fleet templates (marketing/blueprint.ts) + #13 external.send gate",
  },
  {
    id: "V",
    title: "Don't fool yourself — measure real growth",
    principle:
      "Numbers must be real and externally attributable. Vanity metrics and self-generated signals do not count. A funding decision on synthetic demand alone is a constitutional smell.",
    source: "Sam Altman, Startup Playbook; Paul Graham, Default Alive or Default Dead",
    enforcedBy: "#106 outcome verifiers + #101 demand rails (externally-attributed only)",
  },
  {
    id: "VI",
    title: "Big market, focus, intensity",
    principle:
      "A fundable venture clears an adversarial bar: a credible large-market path, a real wedge, a defensible advantage — scored by two independent personas, not one optimistic voice.",
    source: "Sam Altman, Startup Playbook (Part I — A Great Idea / Team)",
    enforcedBy: "#96 venture scorecard + adversarial dual-persona gate + #102 growth loop",
  },
  {
    id: "VII",
    title: "Spend like you're poor",
    principle:
      "Burn is bounded. Autonomous spend stops at a hard dollar ceiling, and projected infra-cost breaches are surfaced before they happen.",
    source: "Sam Altman, Startup Playbook (Part III — Execution / keep burn low)",
    enforcedBy: "dollar-ceiling caps + perf budgets + cost forecast (#108 runbook deepens)",
  },
  {
    id: "VIII",
    title: "Charge money, then raise prices",
    principle:
      "Charge real money and treat pricing as an experiment: raise prices in disciplined increments until deal-loss reveals the ceiling — but a price change is always a proposal for a human.",
    source: "YC Pricing 101 / A Guide to Pricing Strategy",
    enforcedBy: "#119 evidence-priced autonomy + the 10/5/20 pricing ladder (constitution/pricing-ladder.ts)",
  },
] as const;

/** Look up an Article by its roman-numeral id. */
export function articleById(id: ArticleId): Article | undefined {
  return ARTICLES.find((a) => a.id === id);
}
