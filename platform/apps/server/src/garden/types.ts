import type { CostTier, RiskTier } from "../agent-registry/contract.js";

/**
 * The Agent Garden view shapes (#284, ADR-0284). Pure data the route serializes and the console renders.
 *
 * The per-(workspace, agent) enable state is durable (one `garden_agent_enablements` row), but the value the
 * owner SEES (`active`) is reconciled against reality (premortem #200 FM#3): an agent is `active` only when
 * the flag is on AND its state is `enabled` AND its persona is actually seeded in the workspace.
 */

/** The persisted enable state of one agent in one workspace. `disabled` is the default (an unset row). */
export const GARDEN_AGENT_STATES = ["enabled", "pending_approval", "disabled"] as const;
export type GardenAgentState = (typeof GARDEN_AGENT_STATES)[number];

/** What the enable action did, mapped 1:1 from the pure {@link import("./decide.js").decideGardenEnable}. */
export type GardenEnableOutcome = "enabled" | "pending_approval";

/**
 * One agent as the Garden shows it: the (sanitized) contract projection + this workspace's enable state +
 * the production-grounded `active` flag and (when not active) the honest reason. Every free-text field has
 * been run through `sanitizeGardenText` (injection defense), so the client renders DATA, never a directive.
 */
export interface GardenAgentView {
  /** The @-mentionable persona handle (lowercase), e.g. `scout`. */
  handle: string;
  displayName: string;
  /** Human department title (e.g. `SEO`). */
  title: string;
  /** The brand-voice one-liner (sanitized). */
  summary: string;
  /** The advertised capabilities (sanitized). */
  capabilities: string[];
  costTier: CostTier;
  riskTier: RiskTier;
  /** The coarse pricing label derived from the cost tier (no fabricated number — FM#2). */
  priceLabel: string;
  /** Whether enabling this agent requires owner approval (the `external_send` irreversible tier — FM#4). */
  requiresApprovalToEnable: boolean;
  /** Whether the persona is actually seeded in this workspace (the production-grounded fact — FM#3). */
  present: boolean;
  /** The persisted enable state for this (workspace, agent). */
  state: GardenAgentState;
  /** True iff the flag is on AND `state === "enabled"` AND `present` — the reconciled, real on/off. */
  active: boolean;
  /** When NOT active, the honest reason (e.g. "rolling out", "not seeded yet", "awaiting your approval"). */
  inactiveReason: string | null;
}

/** The whole Garden surface for a workspace: whether it can be managed + every agent's view. */
export interface GardenView {
  /** True iff this workspace may enable/disable (flag on + owner-first satisfied). Catalog lists regardless. */
  canManage: boolean;
  agents: GardenAgentView[];
}
