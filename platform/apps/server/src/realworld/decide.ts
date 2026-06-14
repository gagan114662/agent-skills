/**
 * The pure gate core for the real-world tool surface (#231). No IO, no clock. Given a tool and the set
 * of currently-connected external accounts, decides whether the tool can run and whether it needs a
 * #13 approval. The injection-quarantine (#223) is enforced structurally in `service.ts` (disjoint
 * deps), NOT here — this module only classifies.
 */

import type { ServiceKind } from "../onboarding/types.js";
import type { RealWorldToolName, ToolGateContext, ToolGateDecision } from "./types.js";
import { realWorldRequiredAccountKinds, realWorldToolSpec } from "./tools.js";

/** The external accounts a tool acts through (empty for read-only / internal tools). */
export function requiredAccountsFor(name: RealWorldToolName): ServiceKind[] {
  return [...realWorldToolSpec(name).requiredAccounts];
}

/** The required accounts for a tool that are NOT yet connected (empty ⇒ the tool is ready to run). */
export function missingAccountsFor(
  name: RealWorldToolName,
  connected: ReadonlySet<ServiceKind>,
): ServiceKind[] {
  return requiredAccountsFor(name).filter((k) => !connected.has(k));
}

/**
 * Decide one tool's gate in the workspace's current connection state.
 *
 * - A tool with a missing required account is NOT allowed — you cannot publish without a hosting
 *   account, or send without an ESP. The console surfaces exactly what to connect.
 * - An outward/irreversible tool ALWAYS requires a #13 approval (recorded-only until a human approves).
 * - A read-only tool is always allowed and never gated (its output is DATA, quarantined by construction).
 */
export function decideToolGate(name: RealWorldToolName, ctx: ToolGateContext): ToolGateDecision {
  const spec = realWorldToolSpec(name);
  const missingAccounts = missingAccountsFor(name, ctx.connectedAccounts);
  const allowed = missingAccounts.length === 0;
  const reason = !allowed
    ? `connect ${missingAccounts.join(", ")} before the fleet can use ${name}`
    : spec.requiresApproval
      ? `${name} is ${spec.reversibility === "irreversible" ? "irreversible" : "outward"} — requires a #13 approval`
      : `${name} is free (${spec.dataFlow === "read" ? "read-only, #223 quarantined" : "internal"})`;
  return {
    tool: name,
    reversibility: spec.reversibility,
    dataFlow: spec.dataFlow,
    allowed,
    requiresApproval: spec.requiresApproval,
    missingAccounts,
    reason,
  };
}

/**
 * The external account kinds the owner must still connect before a venture can do real work, given the
 * currently-connected kinds. Drives the founder-console `setup.needed` signal (#231).
 */
export function realWorldReadinessNeeded(connected: ReadonlySet<ServiceKind>): ServiceKind[] {
  return realWorldRequiredAccountKinds().filter((k) => !connected.has(k));
}
