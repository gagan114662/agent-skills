/**
 * The executor registry contract + pure payload validators (issue #13). Kept dependency-free (no DB)
 * so the registry shape and validators run in the unit job; the concrete DB-touching executors that
 * implement this interface live in `runtime.ts`. ADR-0013 §2.
 */
import type { FastifyBaseLogger } from "fastify";

/** What an executor needs to run an approved action: the workspace + the member it runs *as*. */
export interface ExecutorContext {
  workspaceId: string;
  requesterMemberId: string;
  log: FastifyBaseLogger;
}

/** Result of validating a submitted payload. `ok:false` → a 400 at submit time (ADR-0013 §2). */
export type ValidationResult = { ok: true } | { ok: false; error: string };

/** A summary line for the review queue / `approval` notification, derived purely from the payload. */
export type Summarizer = (payload: Record<string, unknown>) => string;

/**
 * One runnable action type. `validate` is pure (called at submit); `execute` performs the side
 * effect at approval time, re-checking anything that could have changed (e.g. capability, ADR-0013 §3).
 */
export interface ActionExecutor {
  readonly actionType: string;
  validate(payload: unknown): ValidationResult;
  summarize: Summarizer;
  execute(payload: Record<string, unknown>, ctx: ExecutorContext): Promise<Record<string, unknown>>;
}

/** Immutable registry of executors keyed by action type. */
export type ExecutorRegistry = ReadonlyMap<string, ActionExecutor>;

/** Build a registry from a list of executors (later entries win on a duplicate type). */
export function buildRegistry(executors: ActionExecutor[]): ExecutorRegistry {
  return new Map(executors.map((e) => [e.actionType, e]));
}

// ---- pure validators (shared by the concrete executors in runtime.ts) -------------------------

function asRecord(payload: unknown): Record<string, unknown> | null {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** `chat.post_message` payload: `{ channelId, body }`, both non-empty strings. */
export function validateChatPostMessage(payload: unknown): ValidationResult {
  const p = asRecord(payload);
  if (!p) return { ok: false, error: "payload must be an object" };
  if (!nonEmptyString(p.channelId)) return { ok: false, error: "channelId required" };
  if (!nonEmptyString(p.body)) return { ok: false, error: "body required" };
  return { ok: true };
}

/** `external.send` payload: `{ summary, target? }` — `summary` is required, `target` optional. */
export function validateExternalSend(payload: unknown): ValidationResult {
  const p = asRecord(payload);
  if (!p) return { ok: false, error: "payload must be an object" };
  if (!nonEmptyString(p.summary)) return { ok: false, error: "summary required" };
  if (p.target !== undefined && typeof p.target !== "string") {
    return { ok: false, error: "target must be a string" };
  }
  return { ok: true };
}
