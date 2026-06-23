import type { BacklogEvidence } from "./types.js";

export const FEEDBACK_CHANNELS = ["in_app", "email", "support"] as const;
export type FeedbackChannel = (typeof FEEDBACK_CHANNELS)[number];

export function isFeedbackChannel(value: unknown): value is FeedbackChannel {
  return typeof value === "string" && (FEEDBACK_CHANNELS as readonly string[]).includes(value);
}

export interface FeedbackInput {
  text: string;
  channel: FeedbackChannel;
  reporter?: string;
  url?: string;
}

export interface TriagedFeedback {
  title: string;
  description: string;
  sourceRef: string;
  evidence: BacklogEvidence;
}

const HIGH_SEVERITY = /\b(blocked|blocker|broken|bug|cannot|can't|crash|failed|failing|lost|paying|refund)\b/i;
const MEDIUM_SEVERITY = /\b(confusing|hard|missing|slow|stuck|unclear|unable|won't|workflow)\b/i;

function compactText(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function sourceRefFor(input: FeedbackInput): string {
  const slug = compactText(input.text, 48)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `feedback:${input.channel}:${slug || "item"}`;
}

function severityFor(text: string): number {
  if (HIGH_SEVERITY.test(text)) return 3;
  if (MEDIUM_SEVERITY.test(text)) return 2;
  return 1;
}

function corroborationFor(input: FeedbackInput): number {
  let sources = 1; // the feedback itself
  if (input.reporter?.trim()) sources += 1;
  if (input.url?.trim()) sources += 1;
  return sources;
}

export function triageFeedback(input: FeedbackInput): TriagedFeedback {
  const text = input.text.trim();
  const reporter = input.reporter?.trim();
  const url = input.url?.trim();
  const lines = [`Channel: ${input.channel}`];
  if (reporter) lines.push(`Reporter: ${reporter}`);
  if (url) lines.push(`Receipt: ${url}`);
  lines.push("", text);

  return {
    title: `User feedback: ${compactText(text)}`,
    description: lines.join("\n"),
    sourceRef: sourceRefFor({ ...input, text }),
    evidence: {
      signalCount: 1,
      severityTier: severityFor(text),
      corroboratingSources: corroborationFor({ ...input, text }),
      effortPoints: 2,
    },
  };
}
