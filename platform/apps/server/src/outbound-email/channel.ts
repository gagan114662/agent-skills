/**
 * The outbound-email channel gate (issue #594).
 *
 * This is the single decision point #594 asks for: given a template, a sender, a recipient batch, and
 * the current send caps, decide *what may actually be sent* after every guardrail is applied. It is a
 * pure composition of the existing, separately-tested guards plus this module's new ones — it adds no
 * new sending machinery and, by design, NEVER sends: it returns a decision an executor can act on.
 *
 * The guardrails, in order, and why the order matters:
 *
 *   1. **Per-template approval** ({@link evaluateTemplate}) — an unapproved/edited template is a hard,
 *      whole-batch block. We refuse before even looking at recipients: a template that hasn't cleared
 *      a human must not be sent to anyone.
 *   2. **Deliverability** ({@link confirmDeliverability}, from #268) — a sender that can't prove
 *      SPF/DKIM/DMARC alignment with a real delivered-message receipt is a hard block; sending
 *      unauthenticated mail torches reputation (#200 §3/§4).
 *   3. **Suppression / DNC + consent** ({@link filterContactable}) — ALWAYS enforced: suppressed and
 *      non-consented recipients are dropped from the batch, never sent to. A send with no contactable
 *      recipient left is a block.
 *   4. **Send budget** ({@link combineSendCaps}, from #268 warmup + rate caps) — the contactable set
 *      is truncated to the most-restrictive cap's headroom; a zero budget blocks the send.
 *
 * Total + pure: all IO (the policy/registry reads, the clock, the caps) is injected, so the whole
 * channel is unit-tested offline. Self-contained — touches no DB, schema barrel, or app registry.
 */

import { confirmDeliverability } from "../email/deliverability.js";
import type { DeliverabilityConfirmation, SenderAuthInput } from "../email/deliverability.js";
import { combineSendCaps } from "../email/rate-cap.js";
import type { GrantableCap, SendBudgetDecision } from "../email/rate-cap.js";
import { filterContactable } from "./suppression.js";
import type { ContactPolicy } from "./suppression.js";
import { evaluateTemplate } from "./template-approval.js";
import type { EmailTemplate, TemplateApprovalRegistry, TemplateGateDecision } from "./template-approval.js";

export interface OutboundEmailRequest {
  /** The template to send (its content must be approved). */
  template: EmailTemplate;
  /** The per-template approval registry. */
  templateRegistry: TemplateApprovalRegistry;
  /** The always-enforced suppression/DNC + consent policy. */
  contactPolicy: ContactPolicy;
  /** The intended recipients (normalized + de-duplicated by the gate). */
  recipients: string[];
  /** The sender's authentication evidence (config + optional delivered-message receipt). */
  sender: { auth: SenderAuthInput; authResultsHeader?: string | null };
  /** The send caps to combine (e.g. domain warmup + rolling-window rate cap). */
  caps: { warmup: GrantableCap; rate: GrantableCap };
  /** Current time (epoch ms), injected. */
  now: number;
  /** If set, consent older than this many ms is treated as expired. */
  consentTtlMs?: number;
}

export interface OutboundChannelDecision {
  /** True only when the template is approved, the sender is deliverable, ≥1 recipient is contactable, and budget>0. */
  ok: boolean;
  /** Why the send (as a whole) is blocked; empty when ok. */
  blockedReasons: string[];
  /** The per-template approval verdict. */
  template: TemplateGateDecision;
  /** The deliverability verdict. */
  deliverability: DeliverabilityConfirmation;
  /** The combined warmup + rate send budget over the contactable count. */
  sendBudget: SendBudgetDecision;
  /** Recipients dropped by the always-enforced suppression/consent gate, with reasons. */
  dropped: { email: string; reasons: string[] }[];
  /** Recipients actually cleared to send: contactable, truncated to the send budget. */
  granted: string[];
}

/**
 * Evaluate an outbound-email send against every guardrail and return what may be sent. Pure: returns a
 * decision; performs no IO and sends nothing. `granted` is the only set an executor should ever send
 * to — it is guaranteed to exclude every suppressed / non-consented address and to fit under the caps.
 */
export function evaluateOutboundEmail(req: OutboundEmailRequest): OutboundChannelDecision {
  const blockedReasons: string[] = [];

  // 1. Per-template approval (whole-batch hard gate).
  const template = evaluateTemplate(req.templateRegistry, req.template);
  if (!template.approved) blockedReasons.push(`template not approved: ${template.reason}`);

  // 2. Deliverability (whole-batch hard gate).
  const deliverability = confirmDeliverability({
    auth: req.sender.auth,
    authResultsHeader: req.sender.authResultsHeader,
  });
  if (!deliverability.deliverable) {
    blockedReasons.push(`sender not deliverable: ${deliverability.reasons[0] ?? "authentication unverified"}`);
  }

  // 3. Suppression / DNC + consent — ALWAYS enforced. Suppressed/non-consented are dropped, never sent.
  const { contactable, blocked } = filterContactable(req.contactPolicy, req.recipients, {
    now: req.now,
    consentTtlMs: req.consentTtlMs,
  });
  if (contactable.length === 0) {
    blockedReasons.push("no contactable recipient after suppression/consent enforcement");
  }

  // 4. Send budget (warmup + rate caps) over the contactable count.
  const sendBudget = combineSendCaps(contactable.length, req.caps.warmup, req.caps.rate);
  if (contactable.length > 0 && !sendBudget.allowed) {
    blockedReasons.push(`send budget exhausted: ${sendBudget.reason}`);
  }

  // A template/deliverability block sends to NO ONE. Otherwise, grant the contactable head that fits the budget.
  const hardBlocked = !template.approved || !deliverability.deliverable;
  const granted = hardBlocked ? [] : contactable.slice(0, Math.max(0, sendBudget.grantable));

  return {
    ok: blockedReasons.length === 0,
    blockedReasons,
    template,
    deliverability,
    sendBudget,
    dropped: blocked,
    granted,
  };
}
