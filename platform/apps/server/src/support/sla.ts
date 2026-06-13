import type { SupportDeskCaps } from "./caps.js";

/**
 * Support Desk SLA + resolution metrics (#190, ADR-0190) — **pure + deterministic**.
 *
 * Two honest measurements:
 *   1. `computeSlaBreaches` — first-response SLA. A ticket that is still awaiting a first response (status
 *      not `replied`/`closed`) and is older than `firstResponseSlaMinutes` is a breach. Surfaced read-only
 *      in the founder brief (#104/#173). Computed from ticket age — no stored timer.
 *   2. `computeResolutionMetrics` — resolution rate, grounded in reality (premortem #200 §2). A ticket is
 *      counted **resolved (verified)** ONLY when an external `support_receipt` of kind `resolved` exists for
 *      it. A ticket whose status is `replied`/`closed` with NO such receipt is `resolvedUnverified` and is
 *      reported separately, explicitly **UNVERIFIED** — a self-reported "closed" is not a real resolution.
 */
export type SlaTicketStatus = "open" | "triaged" | "awaiting_approval" | "replied" | "closed";

export interface SlaTicket {
  id: string;
  status: SlaTicketStatus;
  category: string | null;
  createdAt: Date;
}

export interface SlaBreach {
  ticketId: string;
  category: string | null;
  /** Whole minutes the ticket has waited past the SLA window. */
  overdueMinutes: number;
  ageMinutes: number;
}

const RESPONDED: ReadonlySet<SlaTicketStatus> = new Set<SlaTicketStatus>(["replied", "closed"]);

/** Tickets still awaiting a first response past the SLA window, worst-overdue first. Pure. */
export function computeSlaBreaches(tickets: SlaTicket[], caps: SupportDeskCaps, now: Date): SlaBreach[] {
  const slaMs = caps.firstResponseSlaMinutes * 60 * 1000;
  const breaches: SlaBreach[] = [];
  for (const t of tickets) {
    if (RESPONDED.has(t.status)) continue;
    const ageMs = now.getTime() - t.createdAt.getTime();
    if (ageMs <= slaMs) continue;
    breaches.push({
      ticketId: t.id,
      category: t.category,
      ageMinutes: Math.floor(ageMs / 60000),
      overdueMinutes: Math.floor((ageMs - slaMs) / 60000),
    });
  }
  return breaches.sort((a, b) => b.overdueMinutes - a.overdueMinutes);
}

export interface ResolutionReceipt {
  ticketId: string | null;
  kind: string;
}

export interface ResolutionMetrics {
  totalTickets: number;
  /** Tickets with an external `resolved` receipt — the only resolution figure trustworthy enough to act on. */
  resolvedVerified: number;
  /** Tickets marked replied/closed with NO external receipt — reported separately, NOT trustworthy. */
  resolvedUnverified: number;
  /** Tickets still open/triaged/awaiting_approval. */
  openTickets: number;
  /** Verified resolutions ÷ total, in [0,1]. `null` when there are no tickets. The actionable rate. */
  verifiedResolutionRate: number | null;
  /** Always true — a structural reminder that `resolvedUnverified` must never drive a kill/scale decision. */
  unverifiedLabeled: true;
}

/**
 * The resolution roll-up. `resolved` counts come from external receipts only; status-only resolutions are
 * surfaced as `resolvedUnverified` and never folded into the verified rate (premortem #200 §2). Pure.
 */
export function computeResolutionMetrics(tickets: SlaTicket[], receipts: ResolutionReceipt[]): ResolutionMetrics {
  const resolvedTicketIds = new Set(
    receipts.filter((r) => r.kind === "resolved" && r.ticketId).map((r) => r.ticketId as string),
  );
  let resolvedVerified = 0;
  let resolvedUnverified = 0;
  let openTickets = 0;
  for (const t of tickets) {
    if (resolvedTicketIds.has(t.id)) {
      resolvedVerified += 1;
    } else if (RESPONDED.has(t.status)) {
      resolvedUnverified += 1;
    } else {
      openTickets += 1;
    }
  }
  const total = tickets.length;
  return {
    totalTickets: total,
    resolvedVerified,
    resolvedUnverified,
    openTickets,
    verifiedResolutionRate: total > 0 ? resolvedVerified / total : null,
    unverifiedLabeled: true,
  };
}
