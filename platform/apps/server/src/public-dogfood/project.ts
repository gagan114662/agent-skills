import { createHash } from "node:crypto";
import { toTheaterEvent } from "../trace/theater.js";
import type { TraceEvent, TraceEventType, TraceRun } from "../trace/types.js";

export type PublicDogfoodPhase = "thinking" | "tool" | "artifact" | "approval" | "outcome" | "blocked";

export interface PublicDogfoodReceipt {
  id: string;
  agent: string;
  workstream: string;
  phase: PublicDogfoodPhase;
  summary: string;
  artifactLabel: string | null;
  approvalStatus: string | null;
  occurredAt: string;
}

export interface PublicDogfoodFeed {
  slug: string;
  workspaceName: string;
  title: string;
  lastUpdatedAt: string | null;
  receipts: PublicDogfoodReceipt[];
}

export interface TraceRunWithEvents {
  run: TraceRun;
  events: TraceEvent[];
}

export interface ProjectDogfoodFeedInput {
  slug: string;
  workspaceName: string;
  runs: TraceRunWithEvents[];
  limit?: number;
  title?: string;
}

const TOKEN_PATTERNS: RegExp[] = [
  /sk-proj-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /gh[opsu]_[A-Za-z0-9_]{12,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
];

export function dogfoodPhaseForTraceType(type: TraceEventType): PublicDogfoodPhase {
  switch (type) {
    case "model_request":
    case "model_response":
      return "thinking";
    case "tool_call":
      return "tool";
    case "tool_result":
      return "artifact";
    case "approval_decision":
      return "approval";
  }
}

function publicReceiptId(runId: string, eventId: string, seq: number): string {
  const digest = createHash("sha256").update(`${runId}:${eventId}:${seq}`).digest("hex").slice(0, 16);
  return `dogfood_${digest}`;
}

function replaceAllLiteral(value: string, needle: string): string {
  if (!needle) return value;
  return value.split(needle).join("[redacted]");
}

export function scrubPublicDogfoodText(value: string, deniedValues: readonly string[] = []): string {
  let out = value.replace(/\s+/g, " ").trim();
  for (const denied of deniedValues) out = replaceAllLiteral(out, denied);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out.length > 280 ? `${out.slice(0, 279)}…` : out;
}

function phaseFromLabel(label: string | null, type: TraceEventType): PublicDogfoodPhase {
  const lower = (label ?? "").toLowerCase();
  if (lower.includes("blocked") || lower.includes("failed") || lower.includes("error")) return "blocked";
  if (lower.includes("outcome") || lower.includes("shipped") || lower.includes("published")) return "outcome";
  return dogfoodPhaseForTraceType(type);
}

function approvalStatus(event: TraceEvent): string | null {
  if (event.type !== "approval_decision") return null;
  const label = event.label?.trim();
  if (label) return scrubPublicDogfoodText(label);
  const verdict = event.payload.verdict;
  return typeof verdict === "string" && verdict.trim() ? scrubPublicDogfoodText(verdict) : null;
}

function artifactLabel(event: TraceEvent): string | null {
  if (event.type !== "tool_result") return null;
  const label = event.label?.trim();
  return label ? scrubPublicDogfoodText(label) : "artifact";
}

function agentName(run: TraceRun): string {
  return run.agentMemberId ? "Agent" : "ipop fleet";
}

function workstream(run: TraceRun): string {
  return run.label?.trim() || run.taskId?.trim() || "dogfood growth";
}

export function projectDogfoodFeed(input: ProjectDogfoodFeedInput): PublicDogfoodFeed {
  const receipts = input.runs.flatMap(({ run, events }) =>
    events.map((event) => {
      const theater = toTheaterEvent(event);
      const denied = [run.id, run.workspaceId, event.id, event.runId].filter(Boolean);
      return {
        id: publicReceiptId(run.id, event.id, event.seq),
        agent: scrubPublicDogfoodText(agentName(run), denied),
        workstream: scrubPublicDogfoodText(workstream(run), denied),
        phase: phaseFromLabel(event.label, event.type),
        summary: scrubPublicDogfoodText(theater.summary, denied),
        artifactLabel: artifactLabel(event),
        approvalStatus: approvalStatus(event),
        occurredAt: theater.occurredAt,
      } satisfies PublicDogfoodReceipt;
    }),
  );

  receipts.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
  const limited = receipts.slice(0, Math.max(1, Math.min(100, input.limit ?? 30)));

  return {
    slug: input.slug,
    workspaceName: input.workspaceName,
    title: input.title ?? "ipop is marketing itself with ipop",
    lastUpdatedAt: limited[0]?.occurredAt ?? null,
    receipts: limited,
  };
}
