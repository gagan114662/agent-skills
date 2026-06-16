/**
 * The common agent contract (#282, ADR-0282) — the **pure**, dependency-free source of truth that turns
 * each named department agent (scout/echo/quill/postmark/bid/lens/mark) into a first-class, discoverable,
 * composable unit: a declared set of capabilities, typed inputs/outputs, the tool ceiling it carries, a
 * cost tier, and a risk tier. This is the stable consumer surface other features import (mirrors
 * `discovery/contract.ts`): type + builder only, no IO.
 *
 * The contract is **derived from the marketing blueprint** ({@link MARKETING_DEPARTMENTS}) so there is one
 * source of truth and no drift — handle/displayName/department/title/tools/intro come straight from the
 * blueprint; the capability/IO/cost/risk metadata is the per-department table below. An eval-style unit
 * test asserts every blueprint department has a metadata entry (the anti-drift latch), exactly the
 * discipline the skill-colocation gate enforces for metric surfaces.
 *
 * Pure ⇒ unit-testable + extensible: adding a department is one blueprint entry plus one metadata row.
 */
import {
  MARKETING_DEPARTMENTS,
  departmentForHandle,
  isExternalSendDepartment,
  type MarketingDepartment,
} from "../marketing/blueprint.js";

/**
 * The risk tier of an agent — what the blast radius of its work is, so the registry + the A2A call path
 * (and the #13 gate downstream) can reason about it. NONE of the agents can send/spend directly (they
 * carry only draft tools), so this classifies what their *output* can lead to once a human approves it:
 *   - `read_only`      — audits/analysis only; nothing it produces leaves the building (scout, lens).
 *   - `internal_draft` — drafts content/guidance that stays in-channel for review (quill, mark).
 *   - `external_send`  — drafts a thing that, once approved, leaves the building (echo, postmark, bid).
 */
export const RISK_TIERS = ["read_only", "internal_draft", "external_send"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/** A coarse cost estimate (compute/token weight) the registry surfaces for budgeting + routing. */
export const COST_TIERS = ["low", "medium", "high"] as const;
export type CostTier = (typeof COST_TIERS)[number];

/** A declared input or output of an agent — structural metadata, NOT a value carrier. */
export interface AgentIO {
  /** Machine name (e.g. `site_url`, `article_draft`). */
  name: string;
  /** One-line human description. */
  description: string;
  /** Whether the caller must supply this input (inputs only; ignored for outputs). */
  required?: boolean;
}

/** Per-department contract metadata — the part NOT already in the blueprint. Keyed by department `key`. */
interface AgentMetadata {
  /** The named capabilities this agent advertises — the verbs a caller (or another agent) can request. */
  capabilities: readonly string[];
  inputs: readonly AgentIO[];
  outputs: readonly AgentIO[];
  costTier: CostTier;
  riskTier: RiskTier;
  /**
   * The #13 approval-gated action types this agent's output can trigger downstream (observability only —
   * NOT authority). Surfaced so the call path makes the eventual human gate explicit; the agent itself
   * carries no send/spend tool, so nothing here is reachable without the #13 queue (ADR-0013/#243).
   */
  gatedActions: readonly string[];
}

/**
 * The metadata table — one row per blueprint department. A unit test asserts this covers every department
 * (no drift). `riskTier` is consistent with {@link isExternalSendDepartment}: every external-send
 * department is `external_send`, asserted in the test.
 */
const AGENT_METADATA: Readonly<Record<string, AgentMetadata>> = {
  seo: {
    capabilities: ["seo.audit", "seo.keyword_research"],
    inputs: [
      { name: "site_url", description: "The page or site to read the way a crawler does.", required: true },
    ],
    outputs: [
      { name: "seo_audit", description: "Ranked technical-SEO issues with the receipts behind each." },
      { name: "fix_list", description: "Concrete, drafted fixes for the issues found." },
    ],
    costTier: "medium",
    riskTier: "read_only",
    gatedActions: [],
  },
  social: {
    capabilities: ["social.draft_thread", "social.content_calendar"],
    inputs: [{ name: "topic", description: "The idea to turn into a week of posts.", required: true }],
    outputs: [{ name: "social_posts", description: "Draft posts for X/LinkedIn (nothing posts itself)." }],
    costTier: "medium",
    riskTier: "external_send",
    gatedActions: ["external.send"],
  },
  content: {
    capabilities: ["content.draft_article", "content.outline"],
    inputs: [
      { name: "topic", description: "What the piece is about.", required: true },
      { name: "audience", description: "Who it's for (the target reader)." },
    ],
    outputs: [{ name: "article_draft", description: "A human-sounding draft / outline for review." }],
    costTier: "high",
    riskTier: "internal_draft",
    gatedActions: [],
  },
  email: {
    capabilities: ["email.draft_sequence"],
    inputs: [
      { name: "audience", description: "Who the sequence is for.", required: true },
      { name: "goal", description: "What the sequence should achieve." },
    ],
    outputs: [{ name: "email_sequence", description: "Draft emails (never sent — the human hits send)." }],
    costTier: "medium",
    riskTier: "external_send",
    gatedActions: ["external.send"],
  },
  ads: {
    capabilities: ["ads.plan_budget", "ads.draft_campaign"],
    inputs: [
      { name: "goal", description: "The acquisition goal.", required: true },
      { name: "budget", description: "A proposed daily/period budget (no spend without approval)." },
    ],
    outputs: [{ name: "ads_plan", description: "A starter plan with a proposed budget — drafts only." }],
    costTier: "medium",
    riskTier: "external_send",
    // Paid acquisition is MONEY (#243): real spend stays human-gated + recorded-only via #13.
    gatedActions: ["external.send", "venture.ad_spend"],
  },
  analytics: {
    capabilities: ["analytics.report", "analytics.recommend_metrics"],
    inputs: [{ name: "question", description: "What you want the numbers to answer.", required: true }],
    outputs: [{ name: "metrics_report", description: "The one metric that matters, with why." }],
    costTier: "low",
    riskTier: "read_only",
    gatedActions: [],
  },
  brand: {
    capabilities: ["brand.review_voice", "brand.draft_guide"],
    inputs: [{ name: "draft", description: "The copy/asset to check against the house voice.", required: true }],
    outputs: [
      { name: "voice_guide", description: "A one-page voice & tone guide." },
      { name: "brand_flags", description: "Anything that drifts off-voice, flagged for review." },
    ],
    costTier: "low",
    riskTier: "internal_draft",
    gatedActions: [],
  },
  reach: {
    // #280 Comet — autonomous outbound demand-gen. Builds an ICP, finds live-signal prospects, drafts a
    // 1:1 opener; the loop sends email within the per-domain caps (autonomous, money-only governance).
    capabilities: ["reach.build_icp", "reach.draft_opener"],
    inputs: [
      { name: "icp", description: "Who to go after (the ideal-customer profile / live signal).", required: true },
      { name: "goal", description: "What the outbound motion should achieve." },
    ],
    outputs: [
      { name: "prospect_list", description: "Scored, deduped live-signal prospects (no PII leakage)." },
      { name: "opener", description: "A single good 1:1 line per prospect; the loop sends under the caps." },
    ],
    costTier: "high",
    // Comet's work leaves the building (it sends outbound), so it is the highest blast-radius tier.
    riskTier: "external_send",
    // Sends are autonomous under #280 money-only governance; the gated boundary is paid prospect-data
    // credits (`reach.data_credit_spend`, a #243 money action) — surfaced for observability, never authority.
    gatedActions: ["reach.data_credit_spend"],
  },
};

/**
 * The full, declared contract for one fleet agent — the discoverable, composable unit. Everything a
 * registry entry, an A2A call decision, or a console surface needs to reason about the agent without
 * touching its session machinery.
 */
export interface AgentContract {
  /** The @-mentionable persona handle (lowercase), e.g. `scout`. The agent's stable id in the fleet. */
  handle: string;
  displayName: string;
  /** The department key (e.g. `seo`). */
  department: string;
  /** Human department title (e.g. `SEO`). */
  title: string;
  /** The brand-voice one-liner the agent introduces itself with. */
  summary: string;
  capabilities: string[];
  inputs: AgentIO[];
  outputs: AgentIO[];
  /** The agent's tool ceiling (the blueprint draft tools — no send/spend). */
  tools: string[];
  costTier: CostTier;
  riskTier: RiskTier;
  /** #13 action types this agent's output can trigger downstream (observability, never authority). */
  gatedActions: string[];
}

/** Build the declared contract for a department by merging the blueprint with the metadata table. Pure. */
export function buildAgentContract(dept: MarketingDepartment): AgentContract {
  const meta = AGENT_METADATA[dept.key];
  if (!meta) {
    // Defensive: a blueprint department with no metadata row is a drift bug the unit test catches first.
    throw new Error(`agent-registry: no contract metadata for department "${dept.key}"`);
  }
  return {
    handle: dept.agent.handle,
    displayName: dept.agent.displayName,
    department: dept.key,
    title: dept.title,
    summary: dept.agent.intro,
    capabilities: [...meta.capabilities],
    inputs: meta.inputs.map((io) => ({ ...io })),
    outputs: meta.outputs.map((io) => ({ ...io })),
    tools: [...dept.agent.allowedTools],
    costTier: meta.costTier,
    riskTier: meta.riskTier,
    gatedActions: [...meta.gatedActions],
  };
}

/** Every fleet agent's contract, in blueprint order. Pure. */
export function agentContracts(): AgentContract[] {
  return MARKETING_DEPARTMENTS.map(buildAgentContract);
}

/** The contract for one @handle, or undefined when the handle is not a fleet agent. Pure. */
export function contractForHandle(handle: string): AgentContract | undefined {
  const dept = departmentForHandle(handle);
  return dept ? buildAgentContract(dept) : undefined;
}

/** True iff `handle` names a department fleet agent (has a contract). Pure + total. */
export function isFleetHandle(handle: string): boolean {
  return departmentForHandle(handle) !== undefined;
}

/** True iff `capability` is one this handle's contract advertises. Pure + total. */
export function handleHasCapability(handle: string, capability: string): boolean {
  return contractForHandle(handle)?.capabilities.includes(capability) ?? false;
}

/** The set of department keys that carry an external-send risk tier (re-exported for consumers/tests). */
export function isExternalSendRisk(department: string): boolean {
  return isExternalSendDepartment(department);
}
