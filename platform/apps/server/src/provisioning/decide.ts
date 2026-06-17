/**
 * Central-provisioning routing brain (issue #267, ADR-0267). PURE — given a workspace + a capability id +
 * the resolved caps, it decides WHAT happens when a department asks to use a paid API:
 *
 *   - unknown capability                         → `unknown` (fail closed)
 *   - customer's own money (ad budget / email)   → `customer_spend` (ALWAYS #13 money-gated; no key)
 *   - provisioning OFF for this workspace        → `disabled` (the per-dept adapter falls back to mock)
 *   - otherwise                                  → `provisioned`: which provider, which CENTRAL vault key,
 *                                                  used autonomously (ipop's cost of goods, billed in plan)
 *
 * Two premortem (#200) properties are encoded in the SHAPE, not by convention:
 *  - **Money boundary (§4 / #243).** The cost class comes from the structural catalog, never from caller
 *    input: a `customer_spend` capability ALWAYS returns `requiresApproval: true`; a `platform_cost` one
 *    runs autonomously. The customer's own spend stays a money-gated yes; ipop's billed-in cost does not.
 *  - **Injection defense (§6).** The decision is a pure function of the structural `capabilityId` + the
 *    workspace flags. It NEVER inspects any provider RESPONSE or agent-supplied free text, so a poisoned
 *    read can never redirect which provider/credential is used, nor flip the money gate.
 *
 * The decision says WHICH central key to read; the actual vault read (a secret) happens in the service,
 * keeping this module dependency-free + DB-free for the unit job.
 */

import {
  getCapabilityDescriptor,
  centralServiceKey,
  type CapabilityCostClass,
} from "./registry.js";
import { activeProvider, isProvisioningEnabledForWorkspace, type ProvisioningCaps } from "./caps.js";
import { PROVISIONING_CUSTOMER_SPEND_ACTION } from "../approvals/policy.js";

/** The outcome of routing a capability request for a workspace. */
export type ProvisionDecision =
  /** No such capability in the catalog — the caller fails closed (no provisioning, no spend). */
  | { status: "unknown"; capabilityId: string; reason: string }
  /**
   * The capability is the customer's OWN money (ad budget, email-sending tier). There is NO central key;
   * the caller MUST route this through the #13 money queue under `actionType` before any spend. Always.
   */
  | {
      status: "customer_spend";
      capabilityId: string;
      costClass: "customer_spend";
      actionType: typeof PROVISIONING_CUSTOMER_SPEND_ACTION;
      requiresApproval: true;
      reason: string;
    }
  /** Central provisioning is OFF for this workspace — the per-department adapter falls back to mock. */
  | { status: "disabled"; capabilityId: string; reason: string }
  /**
   * Provisioned centrally: ipop's `provider` fulfils it, its credential lives in the OWNER vault under
   * `centralServiceKey`, and it runs autonomously (`requiresApproval: false`) because ipop pays and bills
   * it into the plan. The customer never sees `centralServiceKey` or its secret.
   */
  | {
      status: "provisioned";
      capabilityId: string;
      costClass: "platform_cost";
      provider: string;
      /** Vault `service_key` the credential is read from — in the OWNER workspace, never the customer's. */
      centralServiceKey: string;
      /** Non-secret env-var names the resolved credential supplies (for the adapter). */
      envKeys: string[];
      requiresApproval: false;
      reason: string;
    };

/**
 * Decide how a capability request resolves for a workspace. Order (fail-closed):
 *   1. unknown capability        → `unknown`
 *   2. customer-spend capability → `customer_spend` (money-gated ALWAYS, even when the flag is off — the
 *      customer's money is never autonomous; the gate is intrinsic to the cost class, not the flag)
 *   3. provisioning off          → `disabled`
 *   4. otherwise                 → `provisioned` via the active provider + central vault key.
 *
 * Pure + total. `caps` is the resolved policy; `workspaceId` the tenant asking.
 */
export function decideProvision(
  capabilityId: string,
  caps: ProvisioningCaps,
  workspaceId: string,
): ProvisionDecision {
  const descriptor = getCapabilityDescriptor(capabilityId);
  if (!descriptor) {
    return { status: "unknown", capabilityId, reason: `unknown capability "${capabilityId}"` };
  }

  const costClass: CapabilityCostClass = descriptor.costClass;

  // (2) The customer's OWN money is ALWAYS owner-gated — independent of the provisioning flag. A central
  // key is never involved (their own connected account/budget fulfils it), so there is nothing to provision.
  if (costClass === "customer_spend") {
    return {
      status: "customer_spend",
      capabilityId,
      costClass,
      actionType: PROVISIONING_CUSTOMER_SPEND_ACTION,
      requiresApproval: true,
      reason: `${descriptor.label} is the customer's own money — owner approval required (#243)`,
    };
  }

  // (3) platform_cost but provisioning is off for this workspace → the adapter uses its free mock path.
  if (!isProvisioningEnabledForWorkspace(caps, workspaceId)) {
    return {
      status: "disabled",
      capabilityId,
      reason: "central provisioning is off for this workspace",
    };
  }

  // (4) Provisioned: ipop pays + bills into the plan → autonomous. Pick the active provider (config-mapped,
  // else the free mock) and the central vault key its credential lives under in the OWNER workspace.
  const provider = activeProvider(caps, capabilityId, true) as string; // platform_cost ⇒ always non-null
  return {
    status: "provisioned",
    capabilityId,
    costClass: "platform_cost",
    provider,
    centralServiceKey: centralServiceKey(provider),
    envKeys: descriptor.envKeys,
    requiresApproval: false,
    reason: `provisioned centrally via "${provider}" — billed into the plan, no customer key`,
  };
}
