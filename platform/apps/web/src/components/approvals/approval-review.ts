import type { ApprovalRequestDto, MarketingDraft, MarketingDraftFormat } from "@reload/shared";
import { CONSOLE } from "../../brand.js";
import { DELIVERABLE_ACTION, extractDeliverable, humanActionLabel } from "../console/deliverable.js";

export interface ApprovalDraftSection {
  readonly label: string;
  readonly value: string;
}

export interface ApprovalDraftPreview {
  readonly format: string;
  readonly label: string;
  readonly title: string;
  readonly sections: ApprovalDraftSection[];
  readonly citations: string[];
}

export interface ApprovalEditableDraft {
  readonly field: string;
  readonly label: string;
  readonly value: string;
  readonly synthetic?: boolean;
}

export interface ApprovalReview {
  readonly actionLabel: string;
  readonly previewTitle: string;
  readonly previewBody: string;
  readonly drafts: ApprovalDraftPreview[];
  readonly editable: ApprovalEditableDraft | null;
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

function recordField(payload: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = payload[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const FORMAT_LABELS: Record<MarketingDraftFormat, string> = {
  google_rsa: "Google search ad",
  meta_ad: "Meta ad",
  linkedin_post: "LinkedIn post",
  x_thread: "X thread",
  email: "Email",
  landing_hero: "Landing hero",
  seo_snippet: "Search result",
};

const FIELD_LABELS: Record<string, string> = {
  body: "Body",
  cta: "CTA",
  description: "Description",
  descriptions: "Descriptions",
  headline: "Headline",
  headlines: "Headlines",
  hook: "Hook",
  intent: "Intent",
  metaDescription: "Meta description",
  plainTextAlt: "Plain-text version",
  preheader: "Preheader",
  subject: "Subject",
  subhead: "Subhead",
  title: "Title",
  tweets: "Tweets",
};

const FORMAT_FIELD_ORDER: Record<MarketingDraftFormat, readonly string[]> = {
  google_rsa: ["headlines", "descriptions"],
  meta_ad: ["hook", "body", "headline", "description", "cta"],
  linkedin_post: ["hook", "body", "cta"],
  x_thread: ["tweets"],
  email: ["subject", "preheader", "body", "cta", "plainTextAlt"],
  landing_hero: ["headline", "subhead", "cta"],
  seo_snippet: ["title", "metaDescription", "intent"],
};

const FORMATS = new Set<MarketingDraftFormat>([
  "google_rsa",
  "meta_ad",
  "linkedin_post",
  "x_thread",
  "email",
  "landing_hero",
  "seo_snippet",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMarketingDraft(value: unknown): value is MarketingDraft {
  if (!isRecord(value)) return false;
  return (
    typeof value.title === "string" &&
    typeof value.format === "string" &&
    FORMATS.has(value.format as MarketingDraftFormat) &&
    isRecord(value.fields) &&
    Array.isArray(value.citations) &&
    value.citations.every((citation) => typeof citation === "string")
  );
}

function draftArray(value: unknown): MarketingDraft[] {
  if (Array.isArray(value)) return value.filter(isMarketingDraft);
  if (isRecord(value) && Array.isArray(value.drafts)) return value.drafts.filter(isMarketingDraft);
  return [];
}

function marketingDrafts(payload: Record<string, unknown>): MarketingDraft[] {
  const candidates = [
    payload.drafts,
    payload.draftSet,
    payload.draft_set,
    payload.artifact,
    recordField(payload, "teamArtifact"),
  ];
  const drafts = candidates.flatMap(draftArray);
  const seen = new Set<string>();
  return drafts.filter((draft) => {
    const key = draft.format + ":" + draft.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fieldValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value.map((item, index) => `${index + 1}. ${item}`).join("\n");
  }
  return typeof value === "string" ? value.trim() : "";
}

function marketingDraftPreview(draft: MarketingDraft): ApprovalDraftPreview {
  const order = FORMAT_FIELD_ORDER[draft.format];
  const keys = [
    ...order,
    ...Object.keys(draft.fields).filter((key) => !order.includes(key)),
  ];
  const sections = keys
    .map((key) => ({
      label: FIELD_LABELS[key] ?? key,
      value: fieldValue(draft.fields[key]),
    }))
    .filter((section) => section.value.length > 0);
  return {
    format: draft.format,
    label: FORMAT_LABELS[draft.format],
    title: draft.title,
    sections,
    citations: draft.citations.filter((citation) => citation.trim()),
  };
}

function plainDraftPreview(title: string, body: string): ApprovalDraftPreview {
  return {
    format: "draft",
    label: "Draft",
    title,
    sections: [{ label: "Draft", value: body }],
    citations: [],
  };
}

function draftPreviewText(draft: ApprovalDraftPreview): string {
  const body = draft.sections.map((section) => `${section.label}: ${section.value}`).join("\n");
  return [draft.label + ": " + draft.title, body].filter(Boolean).join("\n");
}

function previewBodyForDrafts(drafts: readonly ApprovalDraftPreview[], fallback: string): string {
  if (drafts.length === 0) return fallback;
  if (drafts.length === 1) return draftPreviewText(drafts[0]!);
  return [
    drafts.length + " channel-native drafts ready for owner review:",
    ...drafts.map((draft) => "- " + draft.label + ": " + draft.title),
  ].join("\n");
}

function editableField(
  payload: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  fallback?: string,
): ApprovalEditableDraft | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return { field: key, label, value: value.trim() };
    }
  }
  const fallbackValue = fallback?.trim();
  return fallbackValue ? { field: "draft", label, value: fallbackValue, synthetic: true } : null;
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
    const structuredDrafts = marketingDrafts(payload).map(marketingDraftPreview);
    const drafts = structuredDrafts.length > 0
      ? structuredDrafts
      : draft
        ? [plainDraftPreview(request.summary, draft)]
        : [];
    const fallback = draft || "No finished deliverable is attached yet.";
    return {
      actionLabel,
      previewTitle: request.summary,
      previewBody: previewBodyForDrafts(drafts, fallback),
      drafts,
      editable: editableField(
        payload,
        ["draft", "body", "content"],
        "Draft",
        structuredDrafts.length > 0 ? structuredDrafts.map(draftPreviewText).join("\n\n---\n\n") : draft,
      ),
      consequence: drafts.length > 1
        ? "Move these " + drafts.length + " channel drafts through the owner gate together."
        : CONSOLE.deliverable.consequence,
      rationale,
      receipt: request.status === "pending"
        ? "Approving records your yes, any inline edit, and the execution receipt."
        : "Decision receipt saved in the audit trail below.",
      risk: request.amount !== null ? `Money approval: ${money(request.amount)} is explicitly gated.` : null,
    };
  }

  if (request.actionType === "external.send") {
    return {
      actionLabel,
      previewTitle: subject || (to ? `Message to ${to}` : request.summary),
      previewBody: [to ? `To: ${to}` : "", subject ? `Subject: ${subject}` : "", body].filter(Boolean).join("\n"),
      drafts: [
        {
          format: "email",
          label: "Email",
          title: subject || (to ? "Message to " + to : request.summary),
          sections: [
            ...(to ? [{ label: "To", value: to }] : []),
            ...(subject ? [{ label: "Subject", value: subject }] : []),
            ...(body ? [{ label: "Body", value: body }] : []),
          ],
          citations: [],
        },
      ],
      editable: editableField(payload, ["body", "message", "text", "content"], "Message"),
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
      drafts: body ? [plainDraftPreview(subject || request.summary, body)] : [],
      editable: editableField(payload, ["body", "message", "text", "content"], "Message"),
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
    drafts: body ? [plainDraftPreview(subject || request.summary, body)] : [],
    editable: editableField(payload, ["body", "message", "text", "content"], "Draft"),
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
