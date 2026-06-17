/**
 * The central provisioning service (issue #267, ADR-0267) — the SHARED runtime seam the per-department
 * adapters (#265/#268/#269/#270/#272) call. It ties together: the pure routing {@link decideProvision}, the
 * server-side {@link CentralCredentialResolver} (the only read-back of a centrally-held key), the read
 * surface (status, which leaks NO key), and the usage ledger (so the cost is billed into the plan).
 *
 * GUARDRAIL: the dependency surface here IS the proof of two invariants:
 *  - **Customer never sees a key.** The only secret read is {@link CentralCredentialResolver.resolveCentral},
 *    consumed by {@link resolveCredential} and returned to a SERVER-side adapter — never to a user-facing
 *    route, never into an agent env passthrough. {@link status} reads only a boolean connected-flag.
 *  - **Money boundary (#243).** A `customer_spend` decision short-circuits with NO credential and an
 *    `actionType` the caller MUST route through the #13 gate. `resolveCredential` cannot return a key for
 *    the customer's own money — there is none to return.
 */

import { decideProvision, type ProvisionDecision } from "./decide.js";
import {
  isProvisioningEnabledForWorkspace,
  type ProvisioningCaps,
} from "./caps.js";
import {
  getCapabilityDescriptor,
  listCapabilityDescriptors,
  centralServiceKey,
  type CapabilityCostClass,
} from "./registry.js";
import type { CentralCredentialResolver } from "./provider.js";
import { buildUsageRecord, type UsageMeasurement, type UsageRecord } from "./usage.js";

/** Sink for metered usage rows. Injected so the service is DB-free in the unit job. */
export interface UsageStore {
  record(row: UsageRecord): Promise<void>;
}

/** The dependencies the service needs — all injected so it is pure-ish + unit-testable without a DB. */
export interface ProvisioningServiceDeps {
  /** Resolve the workspace's provisioning policy (production: `loadConfig` → `resolveProvisioningCaps`). */
  loadCaps: (workspaceId: string) => ProvisioningCaps;
  /** Server-side read-back of a central provider credential (production: the OWNER vault). */
  central: CentralCredentialResolver;
  /** Whether a provider's central credential is connected — boolean only, NO secret (status surface). */
  centralConnected: (provider: string) => Promise<boolean>;
  /** Persist a metered usage row (production: the `provisioning_usage` repo). */
  usage: UsageStore;
  now?: () => number;
}

/** The result of resolving a credential for a capability — what a per-department adapter acts on. */
export type ResolvedProvision =
  /** Use this provider with this server-side env. The customer never sees `env`. */
  | { status: "provisioned"; capabilityId: string; provider: string; env: Record<string, string> }
  /** Provisioned in policy, but no central credential is connected yet → adapter falls back to mock. */
  | { status: "unavailable"; capabilityId: string; provider: string; reason: string }
  /** The customer's own money — caller MUST money-gate under `actionType` before any spend. No key. */
  | { status: "customer_spend"; capabilityId: string; actionType: string; reason: string }
  /** Central provisioning off for this workspace → adapter falls back to mock. */
  | { status: "disabled"; capabilityId: string; reason: string }
  /** Unknown capability → fail closed. */
  | { status: "unknown"; capabilityId: string; reason: string };

/** One capability's state for the read surface — NEVER carries a secret. */
export interface ProvisioningCapabilityStatus {
  capabilityId: string;
  label: string;
  costClass: CapabilityCostClass;
  /** `provisioned` = ipop holds the key + it's connected; `unavailable` = mapped but not connected yet. */
  state: "provisioned" | "unavailable" | "customer_spend" | "disabled" | "unknown";
  /** The active provider id (never a key), or null for customer-spend / disabled. */
  provider: string | null;
  /** Human one-liner for the UI (e.g. "Billed into your plan — no API key needed"). */
  detail: string;
}

export class ProvisioningService {
  private readonly now: () => number;

  constructor(private readonly deps: ProvisioningServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** The pure routing decision for a capability (no I/O). */
  decide(workspaceId: string, capabilityId: string): ProvisionDecision {
    return decideProvision(capabilityId, this.deps.loadCaps(workspaceId), workspaceId);
  }

  /**
   * Resolve a usable credential for a capability. For a `provisioned` decision this reads the central
   * credential server-side; an empty read (key not connected) degrades to `unavailable` so the adapter
   * falls back to mock instead of failing. Every other decision passes through with NO credential.
   */
  async resolveCredential(workspaceId: string, capabilityId: string): Promise<ResolvedProvision> {
    const decision = this.decide(workspaceId, capabilityId);
    switch (decision.status) {
      case "provisioned": {
        const env = await this.deps.central.resolveCentral(decision.provider);
        // Fail closed: a resolver that returns null/undefined (an unexpected vault/decryption state) degrades
        // to `unavailable` (adapter falls back to mock) rather than throwing on `Object.keys`.
        if (!env || Object.keys(env).length === 0) {
          return {
            status: "unavailable",
            capabilityId,
            provider: decision.provider,
            reason: `central credential for "${decision.provider}" not connected`,
          };
        }
        return { status: "provisioned", capabilityId, provider: decision.provider, env };
      }
      case "customer_spend":
        return {
          status: "customer_spend",
          capabilityId,
          actionType: decision.actionType,
          reason: decision.reason,
        };
      case "disabled":
        return { status: "disabled", capabilityId, reason: decision.reason };
      case "unknown":
        return { status: "unknown", capabilityId, reason: decision.reason };
    }
  }

  /**
   * The read surface: every capability's state for a workspace — what the customer's console shows so they
   * see "real keyword data: provisioned by ipop, no key needed" WITHOUT ever touching a secret. For a
   * provisioned capability the connected-flag is a boolean from the vault status API (no secret read).
   */
  async status(workspaceId: string): Promise<ProvisioningCapabilityStatus[]> {
    const caps = this.deps.loadCaps(workspaceId);
    const enabled = isProvisioningEnabledForWorkspace(caps, workspaceId);
    const out: ProvisioningCapabilityStatus[] = [];
    for (const descriptor of listCapabilityDescriptors()) {
      if (descriptor.costClass === "customer_spend") {
        out.push({
          capabilityId: descriptor.id,
          label: descriptor.label,
          costClass: descriptor.costClass,
          state: "customer_spend",
          provider: null,
          detail: "Your own spend — always approved by you before any money moves.",
        });
        continue;
      }
      if (!enabled) {
        out.push({
          capabilityId: descriptor.id,
          label: descriptor.label,
          costClass: descriptor.costClass,
          state: "disabled",
          provider: null,
          detail: "Not provisioned for this workspace yet.",
        });
        continue;
      }
      const decision = this.decide(workspaceId, descriptor.id);
      const provider = decision.status === "provisioned" ? decision.provider : null;
      const connected = provider !== null && (await this.deps.centralConnected(provider));
      out.push({
        capabilityId: descriptor.id,
        label: descriptor.label,
        costClass: descriptor.costClass,
        state: connected ? "provisioned" : "unavailable",
        provider,
        detail: connected
          ? "Billed into your plan — no API key needed."
          : "Being provisioned by ipop — no action needed from you.",
      });
    }
    return out;
  }

  /** Record one metered-usage row (the "bill into the plan" ledger). Returns the shaped row. */
  async meter(measurement: UsageMeasurement): Promise<UsageRecord> {
    const row = buildUsageRecord(measurement, this.now());
    await this.deps.usage.record(row);
    return row;
  }
}

/** The vault service_key a provider's central credential lives under (re-export for the route/default wiring). */
export { centralServiceKey };
/** Re-export for callers that only need the descriptor lookup alongside the service. */
export { getCapabilityDescriptor };
