import type { OutreachConfig } from "../config/schema.js";

/**
 * Resolved outreach engine policy (#225). Fills the hard defaults the config partial omits. Default OFF +
 * `dryrun` sender: the engine composes messages and PARKS them at the #13 gate, but the post-approval send
 * touches nothing in the world (recorded-only) until an owner opts in and connects the channel accounts.
 * `perChannelDailyCap` is the rate ceiling per channel (premortem #200: deliverability/brand protection).
 */
export interface OutreachCaps {
  enabled: boolean;
  sendProvider: string;
  perChannelDailyCap: number;
  /** Append a trackable pay link to the composed body (GAP 3, ADR-0401). Default OFF — body unchanged. */
  payLinkInOutreach: boolean;
}

export const OUTREACH_DEFAULTS: OutreachCaps = {
  enabled: false,
  sendProvider: "dryrun",
  perChannelDailyCap: 50,
  payLinkInOutreach: false,
};

export function resolveOutreachCaps(cfg: OutreachConfig | undefined): OutreachCaps {
  const cap = cfg?.perChannelDailyCap;
  return {
    enabled: cfg?.enabled ?? OUTREACH_DEFAULTS.enabled,
    sendProvider: cfg?.sendProvider ?? OUTREACH_DEFAULTS.sendProvider,
    perChannelDailyCap:
      typeof cap === "number" && Number.isFinite(cap) && cap > 0
        ? Math.trunc(cap)
        : OUTREACH_DEFAULTS.perChannelDailyCap,
    payLinkInOutreach: cfg?.payLinkInOutreach ?? OUTREACH_DEFAULTS.payLinkInOutreach,
  };
}
