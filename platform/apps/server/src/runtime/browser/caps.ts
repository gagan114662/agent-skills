import type { BrowserConfig } from "../../config/schema.js";
import { normaliseAllowlist } from "../egress-allowlist.js";

/**
 * Resolve the per-session agent-browser policy from the layered config (#174, ADR-0174) — mirrors
 * `automations/caps.ts` / `flywheel/caps.ts`. **Default OFF** (`enabled: false`): a deployment that
 * sets no `[browser]` section exposes no browser to any agent. Every cap follows the project-wide
 * `0 = unlimited` convention, so an enabled-but-uncapped workspace gets a browser with no ceiling (the
 * deployment is expected to set real caps; the owner workspace opts in first). The allow/denylist are
 * normalised through the #151 matcher so the runtime compares against a stable, lower-cased form.
 */
export interface BrowserCaps {
  /** The agent-browser flag — OFF by default. A disabled workspace never gets a browser session. */
  enabled: boolean;
  /** Hard cap on page navigations per session (`0` = unlimited). */
  maxPages: number;
  /** Hard cap on browser wall-clock per session, in seconds (`0` = unlimited). */
  maxWallClockSeconds: number;
  /** Hard cap on bytes transferred per session (`0` = unlimited). */
  maxBandwidthBytes: number;
  /** When non-empty, navigation is restricted to these domains (exact or leading-`*.` wildcard). */
  allowlist: string[];
  /** Domains the browser may never reach — checked first, for reads AND writes. */
  denylist: string[];
}

export const BROWSER_DEFAULTS: BrowserCaps = {
  enabled: false,
  maxPages: 0,
  maxWallClockSeconds: 0,
  maxBandwidthBytes: 0,
  allowlist: [],
  denylist: [],
};

export function resolveBrowserCaps(cfg: BrowserConfig | undefined): BrowserCaps {
  return {
    enabled: cfg?.enabled ?? BROWSER_DEFAULTS.enabled,
    maxPages: cfg?.maxPages ?? BROWSER_DEFAULTS.maxPages,
    maxWallClockSeconds: cfg?.maxWallClockSeconds ?? BROWSER_DEFAULTS.maxWallClockSeconds,
    maxBandwidthBytes: cfg?.maxBandwidthBytes ?? BROWSER_DEFAULTS.maxBandwidthBytes,
    allowlist: normaliseAllowlist(cfg?.allowlist),
    denylist: normaliseAllowlist(cfg?.denylist),
  };
}
