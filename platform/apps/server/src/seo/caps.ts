import type { SeoConfig } from "../config/schema.js";
import { isRankProviderKind, type RankProviderKind } from "./types.js";

/**
 * Resolved SEO rank-tracking policy (#294). Fills the hard defaults the config partial omits. Default OFF
 * + `dryrun` provider, so an un-configured workspace tracks nothing and reports nothing — the SEO proof
 * tile stays "not connected" until an owner connects a real rank source (Search Console / a SERP API key
 * in the #192 vault). Recording an external receipt (the webhook / owner-paste path) is always allowed;
 * `enabled` only governs the proactive provider FETCH (which would call a paid API).
 */
export interface SeoCaps {
  enabled: boolean;
  /** Which rank-data provider to fetch from. `dryrun` returns nothing (no network, no spend). */
  provider: RankProviderKind;
  /** Default search market when an observation omits it. */
  defaultCountry: string;
  /** The target keywords the owner wants tracked (structural — never instructions). */
  targetKeywords: string[];
  /** The owner's own workspace id (owner-first rollout marker), or null. */
  ownerWorkspaceId: string | null;
}

export const SEO_DEFAULTS: SeoCaps = {
  enabled: false,
  provider: "dryrun",
  defaultCountry: "us",
  targetKeywords: [],
  ownerWorkspaceId: null,
};

export function resolveSeoCaps(cfg: SeoConfig | undefined): SeoCaps {
  const provider = cfg?.provider;
  return {
    enabled: cfg?.enabled ?? SEO_DEFAULTS.enabled,
    provider: provider && isRankProviderKind(provider) ? provider : SEO_DEFAULTS.provider,
    defaultCountry: cfg?.defaultCountry?.trim().toLowerCase() || SEO_DEFAULTS.defaultCountry,
    targetKeywords: Array.isArray(cfg?.targetKeywords)
      ? cfg!.targetKeywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 100)
      : SEO_DEFAULTS.targetKeywords,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? SEO_DEFAULTS.ownerWorkspaceId,
  };
}
