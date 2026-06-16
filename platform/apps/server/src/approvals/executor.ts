/**
 * The executor registry contract + pure payload validators (issue #13). Kept dependency-free (no DB)
 * so the registry shape and validators run in the unit job; the concrete DB-touching executors that
 * implement this interface live in `runtime.ts`. ADR-0013 §2.
 */
import type { FastifyBaseLogger } from "fastify";

/**
 * Thrown by an executor when the action can't run; the route / `executeApprovedRequest` records the
 * request as `failed` (with this message). Lives in the pure module (no DB) so concrete executors in
 * any feature area can throw it without importing `runtime.ts` (avoiding an import cycle).
 */
export class ActionExecutionError extends Error {}

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

/**
 * `agent.deliverable` payload: `{ sessionId, draft, task?, channelId? }` (#248). A completed agent
 * session's draft surfaced for owner review in the APPROVAL NEEDED queue so a briefed task never
 * "vanishes". NOT a money action (#243 money-only intact) and creates NO new authority: the card is a
 * review receipt, the draft is data. Only `sessionId` is required; the rest is display context.
 */
export function validateAgentDeliverable(payload: unknown): ValidationResult {
  const p = asRecord(payload);
  if (!p) return { ok: false, error: "payload must be an object" };
  if (!nonEmptyString(p.sessionId)) return { ok: false, error: "sessionId required" };
  // `draft`/`task`/`channelId` are optional display context — validate their TYPE when present so
  // malformed data never lands in the DB or breaks the review drawer (gemini #249 review note).
  if (p.draft !== undefined && typeof p.draft !== "string") {
    return { ok: false, error: "draft must be a string" };
  }
  if (p.task !== undefined && typeof p.task !== "string") {
    return { ok: false, error: "task must be a string" };
  }
  if (p.channelId !== undefined && typeof p.channelId !== "string") {
    return { ok: false, error: "channelId must be a string" };
  }
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

/**
 * `browser.action` payload: `{ sessionId, tool, summary, target? }` (#174). A side-effectful agent
 * browser step awaiting a human (a click that mutates, typing into a form). `sessionId`/`tool`/`summary`
 * are required non-empty strings; `target` (the URL) is optional. Recorded-only on approval — the actual
 * browser step re-runs in-session once approved (ADR-0174 §2, same re-check-at-execution model as #13 §3).
 */
export function validateBrowserAction(payload: unknown): ValidationResult {
  const p = asRecord(payload);
  if (!p) return { ok: false, error: "payload must be an object" };
  if (!nonEmptyString(p.sessionId)) return { ok: false, error: "sessionId required" };
  if (!nonEmptyString(p.tool)) return { ok: false, error: "tool required" };
  if (!nonEmptyString(p.summary)) return { ok: false, error: "summary required" };
  // `target` is optional and may be explicitly null (a session-level action with no URL) — only a
  // present, non-null, non-string value is invalid.
  if (p.target !== undefined && p.target !== null && typeof p.target !== "string") {
    return { ok: false, error: "target must be a string" };
  }
  return { ok: true };
}

/**
 * `billing.refund` payload: `{ paymentIntentId, amountCents?, reason? }` (#98). Outbound money — always
 * gated, recorded-only in v1. `paymentIntentId` is required; `amountCents` (when present) must be a
 * positive integer; `reason` (when present) a string.
 */
export function validateBillingRefund(payload: unknown): ValidationResult {
  const p = asRecord(payload);
  if (!p) return { ok: false, error: "payload must be an object" };
  if (!nonEmptyString(p.paymentIntentId)) return { ok: false, error: "paymentIntentId required" };
  if (
    p.amountCents !== undefined &&
    (typeof p.amountCents !== "number" || !Number.isInteger(p.amountCents) || p.amountCents <= 0)
  ) {
    return { ok: false, error: "amountCents must be a positive integer" };
  }
  if (p.reason !== undefined && typeof p.reason !== "string") {
    return { ok: false, error: "reason must be a string" };
  }
  return { ok: true };
}

/**
 * Validate a finance disbursement (#194) — a recorded-only outbound spend the money queue gates. Needs a
 * positive integer `amountCents` and a non-empty `purpose`; `currency`/`ventureIdeaId` optional. The
 * executor never moves money, so this only guards the recorded intent's shape.
 */
export function validateFinanceDisbursement(payload: unknown): ValidationResult {
  const p = asRecord(payload);
  if (!p) return { ok: false, error: "payload must be an object" };
  if (typeof p.amountCents !== "number" || !Number.isInteger(p.amountCents) || p.amountCents <= 0) {
    return { ok: false, error: "amountCents must be a positive integer" };
  }
  if (!nonEmptyString(p.purpose)) return { ok: false, error: "purpose required" };
  if (p.currency !== undefined && typeof p.currency !== "string") {
    return { ok: false, error: "currency must be a string" };
  }
  return { ok: true };
}

/**
 * Validate a venture monetization activation (#188) — a recorded-only MONEY decision the money queue
 * gates. Needs a `planId`, a positive-integer `amountCents` (the price the owner is approving — shown on
 * the card), and a non-empty `ventureName`; `currency`/`previousAmountCents` optional. The executor never
 * moves money (a live link is minted, inbound-only, only after this go), so this only guards the shape.
 */
export function validateMonetizationActivatePrice(payload: unknown): ValidationResult {
  const p = asRecord(payload);
  if (!p) return { ok: false, error: "payload must be an object" };
  if (!nonEmptyString(p.planId)) return { ok: false, error: "planId required" };
  if (typeof p.amountCents !== "number" || !Number.isInteger(p.amountCents) || p.amountCents <= 0) {
    return { ok: false, error: "amountCents must be a positive integer" };
  }
  if (!nonEmptyString(p.ventureName)) return { ok: false, error: "ventureName required" };
  if (p.currency !== undefined && typeof p.currency !== "string") {
    return { ok: false, error: "currency must be a string" };
  }
  if (
    p.previousAmountCents !== undefined &&
    p.previousAmountCents !== null &&
    (typeof p.previousAmountCents !== "number" || !Number.isInteger(p.previousAmountCents))
  ) {
    return { ok: false, error: "previousAmountCents must be an integer" };
  }
  return { ok: true };
}

/**
 * Validate an outreach send (#225) — a recorded-only, IRREVERSIBLE send the owner gates. Needs a
 * `messageId` (the parked `outreach_messages` row the approval flips to `sent`). The recipient + content
 * live on the card via the summary/payload; the executor never resolves a raw address (no PII here) and
 * never makes a network call (recorded-only), so CI/tests never reach out.
 */
export function validateOutreachSend(payload: unknown): ValidationResult {
  const p = asRecord(payload);
  if (!p) return { ok: false, error: "payload must be an object" };
  if (!nonEmptyString(p.messageId)) return { ok: false, error: "messageId required" };
  return { ok: true };
}

/**
 * Validate a venture payout-settings change (#188) — a recorded-only MONEY decision. Needs a `ventureId`
 * and a non-empty `destination` (where money will route). Recorded-only on approval; the owner makes the
 * change in the venture's own Stripe dashboard (no autonomous payout re-routing).
 */
export function validateMonetizationPayoutSettings(payload: unknown): ValidationResult {
  const p = asRecord(payload);
  if (!p) return { ok: false, error: "payload must be an object" };
  if (!nonEmptyString(p.ventureId)) return { ok: false, error: "ventureId required" };
  if (!nonEmptyString(p.destination)) return { ok: false, error: "destination required" };
  return { ok: true };
}
