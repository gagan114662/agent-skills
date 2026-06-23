import type { FastifyBaseLogger } from "fastify";
import type { Identity } from "../auth/identity.js";
import { normalizeRecipient } from "../acquisition/compliance.js";
import { loadEnv } from "../env.js";
import { createRequest as defaultCreateRequest, listHumanReviewers as defaultListHumanReviewers } from "../db/repositories/approvals.js";
import { notify as defaultNotify } from "../notifications/service.js";

/**
 * The agent OUTBOUND EMAIL tool (issue #463, the revenue-blocker-#1 fix). This is the first real
 * execution path the fleet can use to reach someone OUTSIDE ipop's own site: an agent composes an
 * email and queues it — but a real email is the most IRREVERSIBLE acquisition surface (premortem #200
 * §4: a sent email is in a stranger's inbox forever and burns sender reputation), so it is NEVER sent
 * autonomously. Every submit parks a PENDING #13 owner approval showing the exact recipient + subject
 * + body; the owner's per-send "yes" is the only thing that lets it leave the building.
 *
 * This deliberately reuses the existing real-send machinery rather than adding a new lever: the parked
 * request is an `external.send` of the canonical send kind `"email.send"`, so on approval the already-wired
 * acquisition dispatcher (#189) routes it through the suppression / CAN-SPAM-footer / domain-warmup guards
 * to the connected ESP (Postmark, #268) AND the #196 legal/compliance pack governs it (both key on
 * `"email.send"`) — or, by default (no ESP connected / flag off), records it only with no network egress.
 * So the path is genuinely end-to-end and real when the owner wires it, and safe (recorded-only) until then.
 * The pure helpers are unit-tested offline; the IO is injected.
 */

/**
 * The canonical acquisition send kind for an email (`channelForKind("email.send") === "email"`). Using the
 * canonical kind is what makes the path genuinely end-to-end: an earlier value of `"email"` was recognized
 * by NEITHER the #189 dispatcher (`KIND_TO_CHANNEL`) NOR the #196 legal pack (`GOVERNED_KINDS`), so an
 * approved agent email silently fell through to recorded-only and never reached a real inbox (#395).
 */
export const OUTBOUND_EMAIL_KIND = "email.send" as const;

/** A composed email may not be longer than this — a sanity bound, not a deliverability limit. */
const SUBJECT_MAX = 200;
const BODY_MAX = 50_000;

/**
 * A pragmatic single-recipient email check: a non-empty local part, an `@`, and a dotted domain with no
 * internal whitespace. We are intentionally strict (one address, owner-reviewed) rather than RFC-exhaustive.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface OutboundEmailInput {
  to: string;
  subject: string;
  body: string;
}

export type OutboundEmailValidation =
  | { ok: true; to: string; subject: string; body: string }
  | { ok: false; error: string };

/** Validate + normalize an agent-composed email. Pure: the recipient is lowercased, text is trimmed. */
export function validateOutboundEmail(input: OutboundEmailInput): OutboundEmailValidation {
  const to = normalizeRecipient(input.to ?? "");
  if (!EMAIL_RE.test(to)) {
    return { ok: false, error: "a valid recipient email address is required" };
  }
  const subject = (input.subject ?? "").trim();
  if (subject.length === 0) return { ok: false, error: "a subject is required" };
  if (subject.length > SUBJECT_MAX) {
    return { ok: false, error: `the subject must be ${SUBJECT_MAX} characters or fewer` };
  }
  const body = (input.body ?? "").trim();
  if (body.length === 0) return { ok: false, error: "a message body is required" };
  if (body.length > BODY_MAX) {
    return { ok: false, error: `the body must be ${BODY_MAX} characters or fewer` };
  }
  return { ok: true, to, subject, body };
}

export interface OutboundEmailAction {
  actionType: "external.send";
  summary: string;
  payload: Record<string, unknown>;
}

/**
 * Shape the validated email into the EXISTING `external.send` executor payload (`kind: "email"`). The
 * dispatcher reads `recipients`/`subject`/`body`; `target` is set so the #151 egress allowlist can see
 * the recipient domain. Pure — the structural always-gate is enforced by the submitter (status pending),
 * not here.
 */
export function buildOutboundEmailAction(v: {
  to: string;
  subject: string;
  body: string;
}): OutboundEmailAction {
  const summary = `Email to ${v.to}: ${v.subject}`.slice(0, 120);
  return {
    actionType: "external.send",
    summary,
    payload: {
      kind: OUTBOUND_EMAIL_KIND,
      recipients: [v.to],
      target: v.to,
      subject: v.subject,
      body: v.body,
      summary,
    },
  };
}

export type OutboundEmailResult =
  | { ok: true; status: "pending"; requestId: string; summary: string }
  | { ok: false; error: string };

/** A function the agent tool calls to queue an outbound email for owner approval. */
export type OutboundEmailSubmitter = (input: OutboundEmailInput) => Promise<OutboundEmailResult>;

/** Injected IO seams (default to the real repository/notify); overridden in unit tests. */
export interface OutboundEmailSubmitterDeps {
  ttlSeconds?: number;
  createRequest?: typeof defaultCreateRequest;
  listHumanReviewers?: typeof defaultListHumanReviewers;
  notify?: typeof defaultNotify;
  now?: () => number;
}

/**
 * Build the submitter bound to an agent identity. It validates, then ALWAYS creates a PENDING
 * `external.send` request (the always-gate) and alerts the workspace's human reviewers — it never
 * executes the send itself. The send runs only after the owner approves the request through the #13
 * queue, on the existing approve path. Best-effort notification never fails the parked request.
 */
export function createOutboundEmailSubmitter(
  identity: Identity,
  log: FastifyBaseLogger,
  deps: OutboundEmailSubmitterDeps = {},
): OutboundEmailSubmitter {
  const createRequest = deps.createRequest ?? defaultCreateRequest;
  const listHumanReviewers = deps.listHumanReviewers ?? defaultListHumanReviewers;
  const notify = deps.notify ?? defaultNotify;
  const now = deps.now ?? (() => Date.now());

  return async (input) => {
    const v = validateOutboundEmail(input);
    if (!v.ok) return { ok: false, error: v.error };

    const action = buildOutboundEmailAction(v);
    const ttlSeconds = deps.ttlSeconds ?? loadEnv().approval.defaultTtlSeconds;

    const request = await createRequest({
      workspaceId: identity.workspaceId,
      requesterMemberId: identity.memberId,
      actionType: action.actionType,
      payload: action.payload,
      amount: null,
      summary: action.summary,
      // ALWAYS pending — an outbound email is irreversible, so it never auto-approves regardless of policy.
      status: "pending",
      expiresAt: new Date(now() + ttlSeconds * 1000),
      events: [
        { type: "requested", detail: { reason: "outbound email requires owner approval (#463)" } },
      ],
    });

    // Best-effort: alert every human reviewer that a decision is needed (never fails the parked request).
    try {
      const reviewers = await listHumanReviewers(identity.workspaceId, identity.memberId);
      for (const recipientMemberId of reviewers) {
        await notify(log, {
          workspaceId: identity.workspaceId,
          recipientMemberId,
          type: "approval",
          actorMemberId: identity.memberId,
          excerpt: `Approval needed: ${action.summary}`,
        });
      }
    } catch (err) {
      log.error({ err }, "outbound-email: notifying reviewers failed (request still parked)");
    }

    return { ok: true, status: "pending", requestId: request.id, summary: action.summary };
  };
}
