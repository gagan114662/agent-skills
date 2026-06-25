import type { ApprovalRequestDto } from "@reload/shared";
import { CONSOLE } from "../../brand.js";
import { DELIVERABLE_ACTION, extractDeliverable, humanActionLabel } from "../console/deliverable.js";

export interface ApprovalReview {
  readonly actionLabel: string;
  readonly previewTitle: string;
  readonly previewBody: string;
  readonly consequence: string;
  readonly rationale: string;
  readonly receipt: string;
  readonly risk: string | null;
}

function textField(payload: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function compactJson(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload)
    .filter(([, value]) => value !== null && value !== undefined && typeof value !== "object")
    .slice(0, 4);
  if (entries.length === 0) return "No rendered payload is attached yet.";
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join("\n");
}

function money(amount: number): string {
  return `$${amount}`;
}

export function approvalReview(request: ApprovalRequestDto): ApprovalReview {
  const actionLabel = humanActionLabel(request.actionType);
  const payload = request.payload ?? {};
  const to = textField(payload, ["to", "recipient", "email"]);
  const subject = textField(payload, ["subject", "title"]);
  const body = textField(payload, ["body", "message", "text", "content"]);
  const rationale =
    textField(payload, ["rationale", "why", "reason"]) ||
    request.reason ||
    `Policy is holding this ${actionLabel.toLowerCase()} for a human yes.`;

  if (request.actionType === DELIVERABLE_ACTION) {
    const draft = extractDeliverable(textField(payload, ["draft", "body", "content"]));
    return {
      actionLabel,
      previewTitle: request.summary,
      previewBody: draft || "No finished deliverable is attached yet.",
      consequence: CONSOLE.deliverable.consequence,
      rationale,
      receipt: request.status === "pending"
        ? "Approving records your yes and moves this deliverable to Done."
        : "Decision receipt saved in the audit trail below.",
      risk: request.amount !== null ? `Money approval: ${money(request.amount)} is explicitly gated.` : null,
    };
  }

  if (request.actionType === "external.send") {
    return {
      actionLabel,
      previewTitle: subject || (to ? `Message to ${to}` : request.summary),
      previewBody: [to ? `To: ${to}` : "", subject ? `Subject: ${subject}` : "", body].filter(Boolean).join("\n"),
      consequence: to ? `Send this message to ${to} outside the workspace.` : "Send this message outside the workspace.",
      rationale,
      receipt: request.status === "pending"
        ? "Approving runs the sender and saves an execution receipt."
        : "Send receipt is saved in the audit trail below.",
      risk: request.amount !== null
        ? `Money approval: ${money(request.amount)} is explicitly gated before this leaves.`
        : "Irreversible: this leaves the workspace once approved.",
    };
  }

  if (request.actionType === "chat.post_message") {
    return {
      actionLabel,
      previewTitle: subject || request.summary,
      previewBody: body || compactJson(payload),
      consequence: "Post this message into the connected workspace.",
      rationale,
      receipt: request.status === "pending"
        ? "Approving posts the message and saves a delivery receipt."
        : "Post receipt is saved in the audit trail below.",
      risk: "External visibility: teammates will see this once approved.",
    };
  }

  return {
    actionLabel,
    previewTitle: subject || request.summary,
    previewBody: body || compactJson(payload),
    consequence: request.amount !== null
      ? `Run ${actionLabel.toLowerCase()} for ${money(request.amount)}.`
      : `Run ${actionLabel.toLowerCase()}.`,
    rationale,
    receipt: request.status === "pending"
      ? "Approving runs the action and saves an audit receipt."
      : "Decision receipt is saved in the audit trail below.",
    risk: request.amount !== null ? `Money approval: ${money(request.amount)} is explicitly gated.` : null,
  };
}
