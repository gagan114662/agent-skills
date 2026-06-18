/**
 * The pure Agent Garden decisions (#284, ADR-0284). No IO — the route/service supply the caps, the agent
 * contracts (from the #282 registry), the present-persona fact, and the persisted states; these decide what
 * the surface shows and what an enable/disable does.
 *
 *  - {@link decideGardenEnable} is the gate: a `read_only`/`internal_draft` agent enables directly
 *    (reversible, money-free), but an `external_send` (irreversible-action) agent ALWAYS needs an explicit
 *    owner approval first (premortem #200 FM#4) — there is no autonomous-enable path for that tier.
 *  - {@link decideGardenDisable} always allows a disable in-scope (it only ever reduces blast radius).
 *  - {@link projectGardenView} builds the per-workspace view, reconciling the persisted enable state against
 *    the production-grounded persona-presence fact (FM#3) and sanitizing every projected free-text field
 *    (FM#6).
 */
import type { AgentContract } from "../agent-registry/contract.js";
import { gardenPriceLabel } from "./pricing.js";
import { sanitizeGardenText, sanitizeGardenList } from "./sanitize.js";
import type { GardenAgentState, GardenAgentView, GardenView } from "./types.js";

/** True iff enabling this agent must pause for an explicit owner approval (the irreversible tier). Pure. */
export function requiresApprovalToEnable(contract: AgentContract): boolean {
  return contract.riskTier === "external_send";
}

export type GardenEnableDecision =
  /** Reversible, money-free → flip the persisted state straight to `enabled`. */
  | { outcome: "enable" }
  /** `external_send` agent → park a PENDING `garden.enable_agent` #13 request; persist `pending_approval`. */
  | { outcome: "needs_approval" }
  /** Out of scope (flag off / not the owner workspace) or unknown agent → refuse with an honest reason. */
  | { outcome: "refused"; reason: string };

/**
 * Decide what enabling `contract` does for a workspace. Fail-closed: an unknown agent or an out-of-scope
 * workspace refuses. The `external_send` tier always routes to `needs_approval` (FM#4). Pure + total.
 */
export function decideGardenEnable(input: {
  contract: AgentContract | undefined;
  manageInScope: boolean;
}): GardenEnableDecision {
  if (!input.contract) return { outcome: "refused", reason: "unknown agent" };
  if (!input.manageInScope) {
    return { outcome: "refused", reason: "the Agent Garden is not enabled for this workspace" };
  }
  return requiresApprovalToEnable(input.contract)
    ? { outcome: "needs_approval" }
    : { outcome: "enable" };
}

export type GardenDisableDecision =
  | { outcome: "disable" }
  | { outcome: "refused"; reason: string };

/**
 * Decide what disabling `contract` does. A disable only ever REDUCES blast radius, so it is never gated —
 * it just needs a known agent and an in-scope workspace. Pure + total.
 */
export function decideGardenDisable(input: {
  contract: AgentContract | undefined;
  manageInScope: boolean;
}): GardenDisableDecision {
  if (!input.contract) return { outcome: "refused", reason: "unknown agent" };
  if (!input.manageInScope) {
    return { outcome: "refused", reason: "the Agent Garden is not enabled for this workspace" };
  }
  return { outcome: "disable" };
}

/** Build one agent's view, reconciling the stored state against the live roster (FM#3) + sanitizing (FM#6). */
export function projectGardenAgent(input: {
  contract: AgentContract;
  state: GardenAgentState;
  present: boolean;
  canManage: boolean;
}): GardenAgentView {
  const { contract, state, present, canManage } = input;
  // The reconciled, REAL on/off: stored-enabled means nothing unless the surface can manage AND the agent
  // is actually seeded. This is the premortem FM#3 rule — never report a self-asserted "on" as real.
  const active = canManage && state === "enabled" && present;
  const inactiveReason = active
    ? null
    : !canManage
      ? "The Agent Garden is rolling out for your workspace."
      : state === "pending_approval"
        ? "Waiting for your approval to switch this on."
        : state === "enabled" && !present
          ? "Switched on, but its agent isn't on your team yet."
          : "Off — switch it on to put it to work.";
  return {
    handle: contract.handle,
    displayName: sanitizeGardenText(contract.displayName),
    title: sanitizeGardenText(contract.title),
    summary: sanitizeGardenText(contract.summary),
    capabilities: sanitizeGardenList(contract.capabilities),
    costTier: contract.costTier,
    riskTier: contract.riskTier,
    priceLabel: gardenPriceLabel(contract.costTier),
    requiresApprovalToEnable: requiresApprovalToEnable(contract),
    present,
    state,
    active,
    inactiveReason,
  };
}

/**
 * Build the whole Garden view for a workspace from the registry contracts, the present-persona set, and the
 * persisted states. `canManage` gates the toggles (and the reconciled `active`); the catalog lists
 * regardless. Pure + total — the single projection the route serializes. An agent with no stored row reads
 * as `disabled` (default OFF).
 */
export function projectGardenView(input: {
  contracts: readonly AgentContract[];
  presentHandles: readonly string[];
  states: Readonly<Record<string, GardenAgentState>>;
  canManage: boolean;
}): GardenView {
  const present = new Set(input.presentHandles);
  return {
    canManage: input.canManage,
    agents: input.contracts.map((contract) =>
      projectGardenAgent({
        contract,
        state: input.states[contract.handle] ?? "disabled",
        present: present.has(contract.handle),
        canManage: input.canManage,
      }),
    ),
  };
}
