import { SLACK_VOICE } from "./voice.js";
import type { SlackBlock } from "./blocks.js";

/**
 * Pure daily-digest builder (#170). Composes the fleet digest — what the agents did, what needs you,
 * spend — into Block Kit blocks + a plain-text fallback, in house voice. No IO, no clock: the caller
 * (the digest engine) gathers the numbers from the #104 Founder Console aggregate and passes them in,
 * so this stays unit-testable offline and the copy is the single source of truth.
 */

export interface SlackDigestInput {
  /** The product display name (from `slackBrandName`) — never the internal "Reload". */
  brandName: string;
  /** Sessions the fleet launched in the window. */
  sessionsLaunched: number;
  /** Tasks the fleet completed in the window. */
  tasksCompleted: number;
  /** Pending approvals waiting on the human (summaries). */
  pendingApprovals: string[];
  /** Estimated spend in the window, in cents. */
  spendCents: number;
}

export interface SlackDigest {
  /** Plain-text fallback (notifications, screen readers). */
  text: string;
  /** Block Kit blocks. */
  blocks: SlackBlock[];
}

function formatSpend(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

/** Build the daily fleet digest DM. A quiet day (no activity, nothing pending) gets the calm variant. */
export function buildSlackDigest(input: SlackDigestInput): SlackDigest {
  const heading = `${input.brandName} — ${SLACK_VOICE.digestHeading}`;
  const quiet =
    input.sessionsLaunched === 0 &&
    input.tasksCompleted === 0 &&
    input.pendingApprovals.length === 0;

  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: heading } },
  ];

  if (quiet) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: SLACK_VOICE.digestNothing } });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: SLACK_VOICE.signOff }] });
    return { text: `${heading}\n${SLACK_VOICE.digestNothing}`, blocks };
  }

  const activity = `*${SLACK_VOICE.digestActivityLabel}*\n• ${input.sessionsLaunched} session(s) launched\n• ${input.tasksCompleted} task(s) completed`;
  blocks.push({ type: "section", text: { type: "mrkdwn", text: activity } });

  const pendingBody =
    input.pendingApprovals.length === 0
      ? SLACK_VOICE.digestNoPending
      : input.pendingApprovals.map((s) => `• ${s}`).join("\n");
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*${SLACK_VOICE.digestPendingLabel}*\n${pendingBody}` },
  });

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*${SLACK_VOICE.digestSpendLabel}*\n${formatSpend(input.spendCents)}` },
  });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: SLACK_VOICE.signOff }] });

  const text =
    `${heading}\n${input.sessionsLaunched} sessions, ${input.tasksCompleted} tasks, ` +
    `${input.pendingApprovals.length} pending, ${formatSpend(input.spendCents)} spent`;
  return { text, blocks };
}
