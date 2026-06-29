/**
 * Acquisition execution — the dispatcher (issue #189, ADR-0189).
 *
 * This is the seam `approvals/runtime.ts makeExternalSend` delegates to AFTER the #13 approval and the
 * #151 egress check. It is what finally pulls the lever: routes an approved `external.send` to the
 * right channel provider, enforcing the channel guards in code on the way:
 *
 *   - ads    → check the owner-approved budget envelope, spend, record the spend receipt + envelope debit,
 *   - email  → enforce suppression + CAN-SPAM/GDPR footer + domain warmup, send to the cleared remainder,
 *   - social → publish (transient failures are recorded for the brief; retry policy lives in `decide.ts`),
 *   - seo    → publish to the venture site (#153).
 *
 * **Default-OFF, fail-safe:** `dispatch` returns `null` whenever the send is NOT an acquisition kind, or
 * the channel is not cleared to execute (master flag off, channel flag off, provider not connected). A
 * `null` tells `makeExternalSend` to fall back to its recorded-only behavior — so with the flag off the
 * executor is byte-for-byte unchanged. A real send that fails its in-code guard throws
 * `ActionExecutionError` (the #13 request is recorded `failed`), never a silent send.
 *
 * The IO is entirely behind injected seams (providers, stores, caps) so the dispatcher is unit-testable
 * with fakes and no DB.
 */

import { ActionExecutionError } from "../approvals/executor.js";
import {
  channelForKind,
  decideSpendWithinEnvelope,
  type AcquisitionChannel,
  type BudgetEnvelope,
} from "./decide.js";
import { channelExecutes, type AcquisitionCaps } from "./caps.js";
import {
  appendComplianceFooter,
  checkEmailCompliance,
  warmupAllows,
  type FooterInfo,
} from "./compliance.js";
import type { AcquisitionProviders, SendOutcome } from "./providers.js";

/** What the dispatcher can read off the executor payload (all defensive — fields may be absent). */
export interface AcquisitionPayload {
  kind?: unknown;
  summary?: unknown;
  target?: unknown;
  amountCents?: unknown;
  ideaId?: unknown;
  campaign?: unknown;
  subject?: unknown;
  body?: unknown;
  recipients?: unknown;
  network?: unknown;
  section?: unknown;
  slug?: unknown;
  title?: unknown;
}

export interface DispatchContext {
  workspaceId: string;
  requesterMemberId: string;
  /** The #13 approval request that authorized this irreversible send. */
  requestId?: string;
}

/** A persisted send receipt — the external-grounded record (#200 §2/§3) the brief + CAC read from. */
export interface SendReceiptInput {
  workspaceId: string;
  ideaId: string | null;
  channel: AcquisitionChannel;
  kind: string;
  provider: string;
  status: "sent" | "failed" | "suppressed";
  externalId: string | null;
  amountCents: number | null;
  recipientCount: number;
  detail: Record<string, unknown>;
}

/** Owner-approved budget envelope IO (the money decision lives in `decide.ts`; this just loads/debits). */
export interface EnvelopeStore {
  /** The active envelope for (workspace, idea, ads), or null when none is approved. */
  getActiveAdsEnvelope(
    workspaceId: string,
    ideaId: string | null,
  ): Promise<BudgetEnvelope | null>;
  /** Atomically reserve ad spend inside the cap; null means no active envelope or insufficient remaining cap. */
  reserveAdsSpend(workspaceId: string, ideaId: string | null, amountCents: number): Promise<BudgetEnvelope | null>;
  /** Compensate a previously reserved spend when the provider does not successfully charge. */
  refundAdsSpend(workspaceId: string, ideaId: string | null, amountCents: number): Promise<void>;
  /** Debit the envelope by a real spend (after a successful provider charge). */
  debitAdsEnvelope(workspaceId: string, ideaId: string | null, amountCents: number): Promise<void>;
}

export interface SuppressionStore {
  /** The normalized suppression set for a workspace (bounce/complaint/unsubscribe). */
  loadSuppressed(workspaceId: string): Promise<ReadonlySet<string>>;
}

export interface ReceiptStore {
  record(receipt: SendReceiptInput): Promise<void>;
}

export interface OutboundEmailReadbackStore {
  recordEspReadbacks(input: {
    workspaceId: string;
    approvalRequestId: string;
    recipients: readonly string[];
    messageIds: readonly string[];
    provider: string;
    detail: Record<string, unknown>;
  }): Promise<void>;
}

/** How many email sends have gone out today (for warmup headroom), and which warmup day we are on. */
export interface EmailWindowStore {
  /** Sends today for the workspace's sending domain + the warmup day index (days since first send). */
  warmupState(workspaceId: string): Promise<{ dayIndex: number; sentToday: number }>;
}

export interface AcquisitionDispatcherDeps {
  resolveCaps: (workspaceId: string) => AcquisitionCaps;
  providers: AcquisitionProviders;
  envelopes: EnvelopeStore;
  suppressions: SuppressionStore;
  receipts: ReceiptStore;
  outboundReadbacks?: OutboundEmailReadbackStore;
  emailWindow: EmailWindowStore;
  /** The CAN-SPAM/GDPR footer facts for the workspace (from caps/onboarding), or null when unset. */
  footerInfo: (workspaceId: string) => FooterInfo | null;
}

export interface AcquisitionDispatcher {
  dispatch(
    payload: AcquisitionPayload,
    ctx: DispatchContext,
  ): Promise<Record<string, unknown> | null>;
}

// ---- small defensive readers --------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function requiresEmailReadback(provider: string, detail: Record<string, unknown>): boolean {
  if (detail.dryRun === true) return false;
  return provider === "postmark" || provider === "resend";
}

/**
 * Build the production dispatcher over its IO seams. The returned `dispatch`:
 *  1. resolves the kind → channel (null for a non-acquisition send → recorded-only fall-through),
 *  2. checks the channel is cleared to execute (master + channel flag) — else null (recorded-only),
 *  3. runs the channel's in-code guards, calls the provider, records an external receipt.
 */
export function createAcquisitionDispatcher(deps: AcquisitionDispatcherDeps): AcquisitionDispatcher {
  return {
    async dispatch(payload, ctx) {
      const kind = str(payload.kind);
      if (!kind) return null;
      const channel = channelForKind(kind);
      if (!channel) return null; // not an acquisition send — fall back to recorded-only.

      const caps = deps.resolveCaps(ctx.workspaceId);
      if (!channelExecutes(caps, channel)) return null; // flag off → recorded-only (default behavior).

      const ideaId = str(payload.ideaId);
      switch (channel) {
        case "ads":
          return dispatchAds(deps, caps, ctx, payload, ideaId);
        case "email":
          return dispatchEmail(deps, caps, ctx, payload, ideaId);
        case "social":
          return dispatchSocial(deps, ctx, payload, ideaId);
        case "seo":
          return dispatchSeo(deps, ctx, payload, ideaId);
      }
    },
  };
}

async function recordAndReturn(
  deps: AcquisitionDispatcherDeps,
  receipt: SendReceiptInput,
): Promise<Record<string, unknown>> {
  await deps.receipts.record(receipt);
  return {
    recorded: true,
    executed: receipt.status === "sent",
    channel: receipt.channel,
    provider: receipt.provider,
    status: receipt.status,
    externalId: receipt.externalId,
  };
}

// ---- ads: spend inside the owner-approved envelope (AC1) ----------------------------------------

async function dispatchAds(
  deps: AcquisitionDispatcherDeps,
  _caps: AcquisitionCaps,
  ctx: DispatchContext,
  payload: AcquisitionPayload,
  ideaId: string | null,
): Promise<Record<string, unknown>> {
  const amountCents = num(payload.amountCents);
  const campaign = str(payload.campaign) ?? str(payload.target) ?? "campaign";

  const envelope = await deps.envelopes.getActiveAdsEnvelope(ctx.workspaceId, ideaId);
  if (!envelope) {
    throw new ActionExecutionError("no active ad budget envelope — owner must approve a budget first");
  }
  const envelopeDecision = decideSpendWithinEnvelope(envelope, amountCents);
  if (!envelopeDecision.allowed) {
    throw new ActionExecutionError(`${envelopeDecision.reason} — needs owner approval`);
  }

  const reserved = await deps.envelopes.reserveAdsSpend(ctx.workspaceId, ideaId, amountCents);
  if (!reserved) {
    const latest = await deps.envelopes.getActiveAdsEnvelope(ctx.workspaceId, ideaId);
    const latestRemaining = latest ? Math.max(0, latest.capCents - latest.spentCents) : 0;
    throw new ActionExecutionError(
      `ad spend ${amountCents}¢ exceeds envelope remaining ${latestRemaining}¢ — needs owner approval`,
    );
  }

  let outcome: SendOutcome;
  try {
    outcome = await deps.providers.ads.spend({
      workspaceId: ctx.workspaceId,
      ideaId,
      campaign,
      amountCents,
    });
  } catch (err) {
    await deps.envelopes.refundAdsSpend(ctx.workspaceId, ideaId, amountCents);
    throw err;
  }
  if (outcome.status !== "sent") {
    await deps.envelopes.refundAdsSpend(ctx.workspaceId, ideaId, amountCents);
  }
  const envelopeRemaining =
    outcome.status === "sent"
      ? Math.max(0, reserved.capCents - reserved.spentCents)
      : Math.max(0, reserved.capCents - reserved.spentCents + amountCents);
  return recordAndReturn(deps, {
    workspaceId: ctx.workspaceId,
    ideaId,
    channel: "ads",
    kind: "ad.spend",
    provider: outcome.provider,
    status: outcome.status,
    externalId: outcome.externalId,
    amountCents,
    recipientCount: 0,
    detail: { ...outcome.detail, campaign, envelopeRemaining },
  });
}

// ---- email: suppression + footer + warmup, all enforced in code (AC2) --------------------------

async function dispatchEmail(
  deps: AcquisitionDispatcherDeps,
  _caps: AcquisitionCaps,
  ctx: DispatchContext,
  payload: AcquisitionPayload,
  ideaId: string | null,
): Promise<Record<string, unknown>> {
  const subject = str(payload.subject) ?? str(payload.summary) ?? "(no subject)";
  const recipients = strList(payload.recipients);
  if (recipients.length === 0) {
    throw new ActionExecutionError("email send has no recipients");
  }
  const footerInfo = deps.footerInfo(ctx.workspaceId);
  // Always append the compliance footer in code (idempotent) before the compliance check.
  const body = footerInfo
    ? appendComplianceFooter(str(payload.body) ?? "", footerInfo)
    : (str(payload.body) ?? "");

  const suppressed = await deps.suppressions.loadSuppressed(ctx.workspaceId);
  const compliance = checkEmailCompliance({
    body,
    recipients,
    suppressed,
    footerInfo: footerInfo ?? undefined,
  });
  if (!compliance.ok) {
    throw new ActionExecutionError(`email blocked by compliance: ${compliance.violations.join("; ")}`);
  }

  // Domain warmup: a fresh domain may only send a ramping volume/day (deliverability is irreversible).
  const { dayIndex, sentToday } = await deps.emailWindow.warmupState(ctx.workspaceId);
  const warmup = warmupAllows(dayIndex, sentToday, compliance.allowedRecipients.length);
  if (!warmup.allowed) {
    throw new ActionExecutionError(`email blocked by domain warmup: ${warmup.reason}`);
  }
  // Send only as many as the warmup grants (deterministic prefix).
  const toSend = compliance.allowedRecipients.slice(0, warmup.grantable);

  const outcome = await deps.providers.esp.send({
    workspaceId: ctx.workspaceId,
    ideaId,
    subject,
    body,
    recipients: toSend,
  });
  if (outcome.status === "sent" && requiresEmailReadback(outcome.provider, outcome.detail)) {
    if (!deps.outboundReadbacks) {
      throw new ActionExecutionError(
        outcome.provider + " send cannot be proven because the readback recorder is not configured",
      );
    }
    const approvalRequestId = (ctx.requestId ?? "").trim();
    if (!approvalRequestId) {
      throw new ActionExecutionError(outcome.provider + " send cannot be proven without a #13 approval request id");
    }
    const rawMessageIds = Array.isArray(outcome.detail.messageIds)
      ? outcome.detail.messageIds
      : outcome.externalId
        ? [outcome.externalId]
        : [];
    const messageIds = rawMessageIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    if (messageIds.length === 0) {
      throw new ActionExecutionError(outcome.provider + " send returned no production readback message id");
    }
    await deps.outboundReadbacks.recordEspReadbacks({
      workspaceId: ctx.workspaceId,
      approvalRequestId,
      recipients: toSend,
      messageIds,
      provider: outcome.provider,
      detail: outcome.detail,
    });
  }
  return recordAndReturn(deps, {
    workspaceId: ctx.workspaceId,
    ideaId,
    channel: "email",
    kind: "email.send",
    provider: outcome.provider,
    status: outcome.status,
    externalId: outcome.externalId,
    amountCents: null,
    recipientCount: toSend.length,
    detail: {
      ...outcome.detail,
      suppressedDropped: compliance.suppressedRecipients.length,
      warmupGranted: warmup.grantable,
      warmupCap: warmup.capForDay === Number.POSITIVE_INFINITY ? null : warmup.capForDay,
    },
  });
}

// ---- social: publish; failures recorded for the brief (AC3) ------------------------------------

async function dispatchSocial(
  deps: AcquisitionDispatcherDeps,
  ctx: DispatchContext,
  payload: AcquisitionPayload,
  ideaId: string | null,
): Promise<Record<string, unknown>> {
  const network = str(payload.network) ?? str(payload.target) ?? "x";
  const text = str(payload.body) ?? str(payload.summary) ?? "";
  let outcome: SendOutcome;
  try {
    outcome = await deps.providers.social.publish({
      workspaceId: ctx.workspaceId,
      ideaId,
      network,
      text,
    });
  } catch (err) {
    // A thrown provider error is recorded as a failed receipt (surfaces in the brief) then re-thrown so
    // the #13 request is marked failed — never a silent drop.
    await deps.receipts.record({
      workspaceId: ctx.workspaceId,
      ideaId,
      channel: "social",
      kind: "social.post",
      provider: deps.providers.social.kind,
      status: "failed",
      externalId: null,
      amountCents: null,
      recipientCount: 0,
      detail: { network, error: err instanceof Error ? err.message : String(err) },
    });
    throw err instanceof ActionExecutionError ? err : new ActionExecutionError(String(err));
  }
  return recordAndReturn(deps, {
    workspaceId: ctx.workspaceId,
    ideaId,
    channel: "social",
    kind: "social.post",
    provider: outcome.provider,
    status: outcome.status,
    externalId: outcome.externalId,
    amountCents: null,
    recipientCount: 0,
    detail: { ...outcome.detail, network },
  });
}

// ---- seo: publish to the venture site (#153, AC4) ----------------------------------------------

async function dispatchSeo(
  deps: AcquisitionDispatcherDeps,
  ctx: DispatchContext,
  payload: AcquisitionPayload,
  ideaId: string | null,
): Promise<Record<string, unknown>> {
  const section = str(payload.section) ?? "guides";
  const slug = str(payload.slug) ?? str(payload.target) ?? "post";
  const title = str(payload.title) ?? str(payload.summary) ?? slug;
  const outcome = await deps.providers.seo.publish({
    workspaceId: ctx.workspaceId,
    ideaId,
    section,
    slug,
    title,
  });
  return recordAndReturn(deps, {
    workspaceId: ctx.workspaceId,
    ideaId,
    channel: "seo",
    kind: "content.publish",
    provider: outcome.provider,
    status: outcome.status,
    externalId: outcome.externalId,
    amountCents: null,
    recipientCount: 0,
    detail: { ...outcome.detail, section, slug },
  });
}
