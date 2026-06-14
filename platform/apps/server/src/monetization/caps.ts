import type { MonetizationConfig } from "../config/schema.js";

/**
 * Resolve the venture monetization policy from the layered config (#58, #188), applying hard defaults —
 * mirrors `finance/caps.ts`. The feature is **default OFF** (`enabled: false`), owner-workspace-first:
 * a deployment that sets no `monetization` block drafts nothing, ingests no webhooks, and the read routes
 * answer 409. Even when `enabled`, a venture can only charge once its OWN Stripe account is connected
 * (the #192 vault) and the owner approves activation through the #13 money queue.
 */
export interface MonetizationCaps {
  /** Master flag for drafting/activation/webhook ingestion + the read surface. OFF by default. */
  enabled: boolean;
  /** Restrict monetization to the owner workspace (like the #187 factory). */
  ownerWorkspaceOnly: boolean;
  /** Default ISO 4217 currency for drafts when one is not specified. */
  defaultCurrency: string;
  /** Webhook signature replay tolerance in seconds. */
  webhookToleranceSec: number;
  /** Max plans/experiments a single read returns. */
  listLimit: number;
}

export const MONETIZATION_DEFAULTS: MonetizationCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  defaultCurrency: "usd",
  webhookToleranceSec: 300,
  listLimit: 200,
};

export function resolveMonetizationCaps(cfg: MonetizationConfig | undefined): MonetizationCaps {
  return {
    enabled: cfg?.enabled ?? MONETIZATION_DEFAULTS.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? MONETIZATION_DEFAULTS.ownerWorkspaceOnly,
    defaultCurrency: (cfg?.defaultCurrency ?? MONETIZATION_DEFAULTS.defaultCurrency).toLowerCase(),
    webhookToleranceSec: cfg?.webhookToleranceSec ?? MONETIZATION_DEFAULTS.webhookToleranceSec,
    listLimit: cfg?.listLimit ?? MONETIZATION_DEFAULTS.listLimit,
  };
}
