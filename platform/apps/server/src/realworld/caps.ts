import type { RealworldConfig } from "../config/schema.js";

/**
 * Resolved real-world tool surface policy (#231). Fills the hard defaults the config partial omits.
 * Default OFF + `dryrun` publisher: the surface models actions and records receipts but touches nothing
 * in the world until an owner opts in (and connects the accounts each tool acts through).
 */
export interface RealworldCaps {
  enabled: boolean;
  publishProvider: string;
}

export const REALWORLD_DEFAULTS: RealworldCaps = {
  enabled: false,
  publishProvider: "dryrun",
};

export function resolveRealworldCaps(cfg: RealworldConfig | undefined): RealworldCaps {
  return {
    enabled: cfg?.enabled ?? REALWORLD_DEFAULTS.enabled,
    publishProvider: cfg?.publishProvider ?? REALWORLD_DEFAULTS.publishProvider,
  };
}
