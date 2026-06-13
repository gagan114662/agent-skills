import { describe, it, expect } from "vitest";
import { computeSlaBreaches, computeResolutionMetrics, type SlaTicket } from "../../src/support/sla.js";
import { SUPPORT_DESK_DEFAULTS } from "../../src/support/caps.js";

const caps = { ...SUPPORT_DESK_DEFAULTS, firstResponseSlaMinutes: 60 };
const now = new Date("2026-06-13T12:00:00Z");

function ticket(over: Partial<SlaTicket>): SlaTicket {
  return { id: "t", status: "open", category: "support", createdAt: now, ...over };
}

describe("support/sla — breach detection (#190)", () => {
  it("flags an unanswered ticket older than the SLA window", () => {
    const old = new Date(now.getTime() - 120 * 60000); // 2h old, SLA 60m
    const breaches = computeSlaBreaches([ticket({ id: "t1", createdAt: old })], caps, now);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]!.ticketId).toBe("t1");
    expect(breaches[0]!.overdueMinutes).toBe(60);
    expect(breaches[0]!.ageMinutes).toBe(120);
  });

  it("does NOT flag a ticket within the SLA window", () => {
    const recent = new Date(now.getTime() - 30 * 60000);
    expect(computeSlaBreaches([ticket({ createdAt: recent })], caps, now)).toEqual([]);
  });

  it("does NOT flag replied/closed tickets (they got a first response)", () => {
    const old = new Date(now.getTime() - 600 * 60000);
    const tickets = [ticket({ id: "r", status: "replied", createdAt: old }), ticket({ id: "c", status: "closed", createdAt: old })];
    expect(computeSlaBreaches(tickets, caps, now)).toEqual([]);
  });

  it("awaiting_approval still counts as awaiting a first response (a draft is queued, not sent)", () => {
    const old = new Date(now.getTime() - 120 * 60000);
    const breaches = computeSlaBreaches([ticket({ id: "a", status: "awaiting_approval", createdAt: old })], caps, now);
    expect(breaches).toHaveLength(1);
  });

  it("sorts worst-overdue first", () => {
    const t1 = ticket({ id: "t1", createdAt: new Date(now.getTime() - 90 * 60000) });
    const t2 = ticket({ id: "t2", createdAt: new Date(now.getTime() - 300 * 60000) });
    const breaches = computeSlaBreaches([t1, t2], caps, now);
    expect(breaches.map((b) => b.ticketId)).toEqual(["t2", "t1"]);
  });
});

describe("support/sla — resolution metrics are reality-grounded (#190, premortem §2)", () => {
  it("counts resolved ONLY when an external receipt says so; status-only is UNVERIFIED", () => {
    const tickets = [
      ticket({ id: "verified", status: "closed" }),
      ticket({ id: "status-only", status: "replied" }),
      ticket({ id: "open", status: "open" }),
    ];
    const receipts = [{ ticketId: "verified", kind: "resolved" }];
    const m = computeResolutionMetrics(tickets, receipts);
    expect(m.resolvedVerified).toBe(1);
    expect(m.resolvedUnverified).toBe(1);
    expect(m.openTickets).toBe(1);
    expect(m.verifiedResolutionRate).toBeCloseTo(1 / 3);
    expect(m.unverifiedLabeled).toBe(true);
  });

  it("a non-'resolved' receipt kind (e.g. delivered) does not count as a resolution", () => {
    const tickets = [ticket({ id: "t", status: "replied" })];
    const m = computeResolutionMetrics(tickets, [{ ticketId: "t", kind: "delivered" }]);
    expect(m.resolvedVerified).toBe(0);
    expect(m.resolvedUnverified).toBe(1);
  });

  it("null rate when there are no tickets", () => {
    expect(computeResolutionMetrics([], []).verifiedResolutionRate).toBeNull();
  });

  it("an external receipt overrides an open status (the receipt is the source of truth)", () => {
    const m = computeResolutionMetrics([ticket({ id: "t", status: "open" })], [{ ticketId: "t", kind: "resolved" }]);
    expect(m.resolvedVerified).toBe(1);
    expect(m.openTickets).toBe(0);
  });
});
