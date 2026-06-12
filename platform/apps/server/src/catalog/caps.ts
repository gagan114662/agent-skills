import type { CatalogConfig } from "../config/schema.js";

/**
 * Resolve the per-tenant catalog policy from the layered config (#58), applying hard defaults — mirrors
 * `automations/caps.ts`. **Default OFF** (`enabled: false`): catalog reads + writes are gated so a
 * deployment that sets no `catalog` section exposes nothing until an owner opts in. `maxEntries` caps
 * how many assets a workspace may register (a guard against unbounded rows).
 */
export interface CatalogCaps {
  /** The catalog feature flag. OFF by default. */
  enabled: boolean;
  /** Hard cap on catalog entries a workspace may register. */
  maxEntries: number;
}

export const CATALOG_DEFAULTS: CatalogCaps = {
  enabled: false,
  maxEntries: 200,
};

export function resolveCatalogCaps(cfg: CatalogConfig | undefined): CatalogCaps {
  return {
    enabled: cfg?.enabled ?? CATALOG_DEFAULTS.enabled,
    maxEntries: cfg?.maxEntries ?? CATALOG_DEFAULTS.maxEntries,
  };
}
