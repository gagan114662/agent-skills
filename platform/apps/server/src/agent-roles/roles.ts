/**
 * The canonical five-role roster (issue #586). Plain declarative data — the single source of truth for what
 * each agent in the marketing/ops fleet is *for*. Editing a mandate, scoping a toolset, or adding an output
 * is a one-line change here; nothing else in the module hard-codes a role.
 *
 * The roles form an end-to-end pipeline — scout (find) → strategist (decide) → writer (make) →
 * distributor (send) → analyst (measure) — and the toolsets are deliberately disjoint at the dangerous
 * edges: only the distributor may actually send/publish, only the analyst reads the warehouse, so a
 * mis-route can never, say, let a drafting agent blast an audience.
 */

import type { AgentRole, RoleDefinition } from "./types.js";

/**
 * The five role definitions, keyed by id. Frozen so a caller cannot mutate the shared roster at runtime
 * (the registry hands out copies of the tool/output lists where mutation would matter).
 */
export const ROLE_DEFINITIONS: Readonly<Record<AgentRole, RoleDefinition>> = Object.freeze({
  scout: {
    id: "scout",
    title: "Scout",
    mandate:
      "Find and qualify prospects, accounts, and market signals; surface intel for the rest of the fleet to act on.",
    allowedTools: ["web.search", "web.fetch", "crm.read", "enrichment.lookup", "signals.read"],
    outputs: ["prospect-list", "account-research", "signal-report"],
    handlesTaskKinds: ["research"],
    keywords: [
      "find",
      "research",
      "discover",
      "prospect",
      "prospects",
      "lead",
      "leads",
      "scout",
      "enrich",
      "enrichment",
      "intel",
      "signal",
      "signals",
      "qualify",
      "icp",
      "market",
    ],
  },
  strategist: {
    id: "strategist",
    title: "Strategist",
    mandate:
      "Decide the approach: segment the audience, set positioning and sequencing, and turn goals into a prioritized plan.",
    allowedTools: ["crm.read", "analytics.read", "brief.read", "brief.write", "planner.write"],
    outputs: ["campaign-plan", "segmentation", "messaging-strategy", "priority-queue"],
    handlesTaskKinds: ["strategy"],
    keywords: [
      "strategy",
      "strategize",
      "plan",
      "planning",
      "segment",
      "segmentation",
      "positioning",
      "prioritize",
      "prioritise",
      "sequence",
      "approach",
      "targeting",
      "goal",
      "goals",
      "roadmap",
    ],
  },
  writer: {
    id: "writer",
    title: "Writer",
    mandate:
      "Produce the copy and creative — emails, posts, ad creative, landing copy — on-brief and on-voice, ready to ship.",
    allowedTools: ["brief.read", "content.write", "asset.read", "asset.write", "llm.generate"],
    outputs: ["email-copy", "social-post", "ad-creative", "landing-copy"],
    handlesTaskKinds: ["drafting"],
    keywords: [
      "write",
      "writer",
      "draft",
      "copy",
      "copywrite",
      "content",
      "compose",
      "headline",
      "subject",
      "creative",
      "post",
      "email",
      "caption",
      "rewrite",
      "edit",
    ],
  },
  distributor: {
    id: "distributor",
    title: "Distributor",
    mandate:
      "Get approved content out the door: schedule and send across channels (email, social, ads) and confirm delivery.",
    allowedTools: ["email.send", "social.publish", "ads.publish", "scheduler.write", "channel.read"],
    outputs: ["send-receipt", "publish-confirmation", "schedule"],
    handlesTaskKinds: ["distribution"],
    keywords: [
      "send",
      "distribute",
      "distribution",
      "publish",
      "post",
      "schedule",
      "deliver",
      "delivery",
      "broadcast",
      "launch",
      "blast",
      "dispatch",
      "channel",
      "channels",
    ],
  },
  analyst: {
    id: "analyst",
    title: "Analyst",
    mandate:
      "Measure what happened: pull metrics, attribute outcomes to campaigns, and report results back into the loop.",
    allowedTools: ["analytics.read", "warehouse.read", "attribution.read", "report.write"],
    outputs: ["performance-report", "attribution-breakdown", "metrics-dashboard"],
    handlesTaskKinds: ["analysis"],
    keywords: [
      "analyze",
      "analyse",
      "analyst",
      "measure",
      "metric",
      "metrics",
      "report",
      "reporting",
      "attribution",
      "attribute",
      "performance",
      "results",
      "conversion",
      "roi",
      "dashboard",
    ],
  },
});
