import type { VoiceCategory } from "../voice/classify.js";
import type { SupportDeskCaps } from "./caps.js";
import { detectEscalation, type EscalationInput, type EscalationResult } from "./escalation.js";

/**
 * The Support Desk routing decision (#190, ADR-0190) — **pure + deterministic**, the centerpiece of the
 * bounded-autonomy design. Given a classified, KB-drafted ticket it returns exactly ONE route:
 *
 *   - `money_queue` — a refund/billing intent. A #13 `billing.refund` draft a human approves; NEVER auto-
 *     executed. Wins over everything else (money is the most irreversible class, premortem #200 §4).
 *   - `escalate`    — anger / legal / unknown. Needs a human; no autonomous send.
 *   - `auto_send`   — the ONLY autonomous route, and only when EVERY fence passes (see below).
 *   - `approval`    — the safe default: draft → #13 pending request → a human approves the send.
 *
 * `auto_send` requires the conjunction of: `caps.autoSend` ON, the workspace allowed (owner-only honored),
 * `category ∈ caps.autoSendCategories`, `churnRisk ≠ high`, NO escalation reason, and the per-day send
 * cap not yet reached. The decision reads only the classification + a quarantined risk scan — never the
 * body's "instructions" — so a poisoned read can at most push toward `escalate`/`money_queue`, never
 * toward `auto_send` (premortem #200 §6). Even an `auto_send` is executed through the one #13 path.
 */
export type SupportRoute = "auto_send" | "approval" | "escalate" | "money_queue";

export interface SupportRoutingInput {
  category: VoiceCategory;
  sentiment: EscalationInput["sentiment"];
  churnRisk: EscalationInput["churnRisk"];
  /** The raw, untrusted inbound body — passed straight to the quarantined escalation scan. */
  body: string;
  /** KB match confidence (0..1) the draft was built with. */
  kbConfidence: number;
  /** Whether this is the owner workspace (gates `ownerWorkspaceOnly`). */
  isOwnerWorkspace: boolean;
  /** Autonomous sends already made for this workspace in the rolling day (the cap counter). */
  autoSendsToday: number;
  caps: SupportDeskCaps;
}

export interface SupportRoutingDecision {
  route: SupportRoute;
  /** A short, auditable reason string (e.g. `auto_send:support`, `money_queue:refund`, `escalate:legal,anger`). */
  reason: string;
  escalation: EscalationResult;
}

export function decideSupportRouting(input: SupportRoutingInput): SupportRoutingDecision {
  const escalation = detectEscalation({
    category: input.category,
    sentiment: input.sentiment,
    churnRisk: input.churnRisk,
    body: input.body,
    kbConfidence: input.kbConfidence,
  });

  // 1. Money is the most irreversible class — a refund/billing intent ALWAYS routes to the MONEY queue
  //    (a human-approved #13 billing.refund draft), even if other escalation reasons also fired.
  if (escalation.reasons.includes("refund")) {
    return { route: "money_queue", reason: "money_queue:refund", escalation };
  }

  // 2. Any other escalation reason (anger / legal / unknown) → a human. No autonomous send.
  if (escalation.escalate) {
    return { route: "escalate", reason: `escalate:${escalation.reasons.join(",")}`, escalation };
  }

  // 3. Auto-send is the ONLY autonomous route and demands the full conjunction of fences. Any failure
  //    falls through to the safe `approval` default — never a silent send.
  const fences: Array<[boolean, string]> = [
    [input.caps.autoSend, "autoSend_off"],
    [!input.caps.ownerWorkspaceOnly || input.isOwnerWorkspace, "not_owner_workspace"],
    [input.caps.autoSendCategories.includes(input.category), "category_not_allowed"],
    [input.churnRisk !== "high", "churn_high"],
    [input.autoSendsToday < input.caps.autoSendMaxPerDay, "daily_cap_reached"],
  ];
  const blocked = fences.find(([ok]) => !ok);
  if (blocked) {
    return { route: "approval", reason: `approval:${blocked[1]}`, escalation };
  }

  return { route: "auto_send", reason: `auto_send:${input.category}`, escalation };
}
