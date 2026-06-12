import type { SlackConfig } from "../config/schema.js";

/**
 * Resolve the Slack-native policy from the layered config (#58, #170), applying hard defaults — mirrors
 * `marketing/caps.ts` and `watchdog/caps.ts`. **Default OFF**: a deployment that sets no `slack` section
 * sends no proactive digest. The inbound surfaces (mention bridge, approval buttons) are gated by
 * whether a workspace has *connected* a Slack app, not by `enabled` — `enabled`/`digestEnabled` gate
 * only the proactive daily digest DM.
 */
export interface SlackCaps {
  /** The proactive Slack surface (the digest tick) is on. OFF by default. */
  enabled: boolean;
  /** Send the daily fleet digest as an owner DM. OFF by default. */
  digestEnabled: boolean;
}

export const SLACK_DEFAULTS: SlackCaps = {
  enabled: false,
  digestEnabled: false,
};

export function resolveSlackCaps(cfg: SlackConfig | undefined): SlackCaps {
  return {
    enabled: cfg?.enabled ?? SLACK_DEFAULTS.enabled,
    digestEnabled: cfg?.digestEnabled ?? SLACK_DEFAULTS.digestEnabled,
  };
}
