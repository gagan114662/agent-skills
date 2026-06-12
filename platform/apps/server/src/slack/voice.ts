/**
 * House-voice copy for the Slack surface (#170). Server-side composed text (digests, approval DMs)
 * lives here — mirrored, not imported, from the web `brand.ts` `VOICE` (the web can't reach server
 * code). Warm, first-person plural, receipts over adjectives. Keep ALL user-facing Slack strings here
 * so there are no hardcoded copy strings scattered through the service. Brand name comes from
 * `RELOAD_BRAND_NAME` so "Reload" never leaks into a customer's Slack.
 */

/** The product's display name in Slack copy (defaults to the pop brand; never the internal "Reload"). */
export function slackBrandName(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.RELOAD_BRAND_NAME;
  return raw && raw.trim().length > 0 ? raw.trim() : "ipop";
}

export const SLACK_VOICE = {
  signOff: "made by robots, steered by humans.",
  /** Approval DM heading. */
  approvalTitle: "A decision needs a human",
  /** Approval DM intro (the summary is appended). */
  approvalIntro: "One of the agents drafted something that needs your sign-off before it goes out:",
  approveButton: "Approve",
  rejectButton: "Reject",
  approvedAck: "Approved — we ran it. ✅",
  rejectedAck: "Rejected — we held it. Nothing went out.",
  alreadyDecided: "That one's already been decided. Nothing more to do here.",
  cannotDecide: "You can't clear this approval — it needs a different human.",
  /** Digest DM heading prefix; the brand name is prepended by the builder. */
  digestHeading: "Here's your fleet, today",
  digestNothing: "Quiet day. The agents didn't need you — nothing's waiting.",
  digestActivityLabel: "What the agents did",
  digestPendingLabel: "What needs you",
  digestSpendLabel: "Spend",
  digestNoPending: "Nothing waiting on you. Go get a coffee — we've got this.",
} as const;
