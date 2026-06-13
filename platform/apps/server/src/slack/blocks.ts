import { SLACK_VOICE } from "./voice.js";

/**
 * Pure Block Kit builders (#170). Slack messages are plain JSON ("blocks"); these functions shape the
 * two interactive/proactive surfaces — the approval DM (Approve/Reject buttons) and the daily digest —
 * with no IO and no clock, so they're unit-tested offline. Copy comes from {@link SLACK_VOICE}.
 */

/** A Block Kit block. Slack's schema is open; we keep it as loose JSON the client serializes verbatim. */
export type SlackBlock = Record<string, unknown>;

/** The action ids the interactivity route matches on a button click. */
export const SLACK_APPROVE_ACTION = "ipop_approve";
export const SLACK_REJECT_ACTION = "ipop_reject";

export interface ApprovalMessageInput {
  /** The approval request id (round-trips in the button value). */
  requestId: string;
  /** The workspace id (round-trips in the button value so the route is tenant-scoped). */
  workspaceId: string;
  /** One-line human-readable summary of the action awaiting a decision. */
  summary: string;
}

/** The Block Kit message DMed to the owner when an action goes pending — Approve/Reject buttons. */
export function buildApprovalBlocks(input: ApprovalMessageInput): SlackBlock[] {
  const value = JSON.stringify({ rid: input.requestId, wid: input.workspaceId });
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${SLACK_VOICE.approvalTitle}*\n${SLACK_VOICE.approvalIntro}` },
    },
    { type: "section", text: { type: "mrkdwn", text: `> ${input.summary}` } },
    {
      type: "actions",
      block_id: `ipop_approval_${input.requestId}`,
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: SLACK_VOICE.approveButton },
          action_id: SLACK_APPROVE_ACTION,
          value,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: SLACK_VOICE.rejectButton },
          action_id: SLACK_REJECT_ACTION,
          value,
        },
      ],
    },
  ];
}

/** One service awaiting the owner, for the #192 setup checklist DM. */
export interface SetupChecklistItem {
  displayName: string;
  /** A one-line "what + why + cost" summary (from the pure `buildSetupSummary`). */
  summary: string;
  /** `reversible` | `cheap` | `irreversible` — irreversible (domain/payment) is flagged for the owner. */
  reversibility: string;
}

/**
 * The Block Kit message DMed to the owner listing the external accounts the fleet needs them to set up
 * (#192, acceptance 2). Each item is "create account → paste keys → done"; an irreversible (money) item
 * is flagged so the owner knows it's a real spend. Pure — no IO, unit-tested offline. A connect link is
 * not a button (pasting keys happens in the console/Settings, never in Slack) — this is a nudge + list.
 */
export function buildSetupChecklistBlocks(input: {
  items: SetupChecklistItem[];
}): SlackBlock[] {
  const header = `*Setup needed* — ${input.items.length} external ${
    input.items.length === 1 ? "account" : "accounts"
  } need you. Create the account and paste the keys in Settings → Connections; the fleet takes it from there.`;
  const blocks: SlackBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: header } },
    { type: "divider" },
  ];
  for (const item of input.items) {
    const flag = item.reversibility === "irreversible" ? " :warning: *money*" : "";
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `• *${item.displayName}*${flag}\n  ${item.summary}` },
    });
  }
  return blocks;
}

/** Parse a button's `value` payload back into the (rid, wid) the interactivity route acts on. */
export function parseApprovalActionValue(
  value: unknown,
): { requestId: string; workspaceId: string } | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as { rid?: unknown; wid?: unknown };
    if (typeof parsed.rid === "string" && typeof parsed.wid === "string") {
      return { requestId: parsed.rid, workspaceId: parsed.wid };
    }
  } catch {
    /* malformed value → no action */
  }
  return null;
}
