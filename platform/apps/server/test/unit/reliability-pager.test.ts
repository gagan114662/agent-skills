import { describe, it, expect, vi } from "vitest";
import { PagerService, type PagerDeps } from "../../src/reliability/pager/service.js";
import { resolveReliabilityCaps, type ReliabilityCaps } from "../../src/reliability/caps.js";

const NOON = new Date("2026-06-11T12:00:00Z");

function makePager(overrides: Partial<PagerDeps> = {}, caps?: Partial<ReliabilityCaps>) {
  const sends: Array<{ to: string; subject: string }> = [];
  const audit: Array<{ delivered: boolean; suppressedReason: string | null; recipient: string }> = [];
  const deps: PagerDeps = {
    ownerContact: vi.fn(async () => ({ memberId: "m-1", email: "owner@acme.com", displayName: "Owner" })),
    caps: () => ({ ...resolveReliabilityCaps({ enabled: true }), ...caps }),
    recentPageCount: vi.fn(async () => 0),
    recordPage: vi.fn(async (input) =>
      void audit.push({ delivered: input.delivered, suppressedReason: input.suppressedReason, recipient: input.recipient }),
    ),
    transport: { send: vi.fn(async (msg) => void sends.push({ to: msg.to, subject: msg.subject })) },
    now: () => NOON,
    ...overrides,
  };
  return { pager: new PagerService(deps), deps, sends, audit };
}

function pageInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws-1",
    source: "sre" as const,
    incidentId: "inc-1",
    kind: "opened" as const,
    severity: "critical" as const,
    lastPagedAt: null,
    ackedAt: null,
    subject: "Incident OPENED: api availability",
    body: "api availability breached.",
    ...overrides,
  };
}

describe("PagerService.page", () => {
  it("delivers to the owner's verified email and audits delivered=true", async () => {
    const { pager, sends, audit } = makePager();
    const r = await pager.page(pageInput());
    expect(r).toEqual({ delivered: true, reason: "opened" });
    expect(sends).toEqual([{ to: "owner@acme.com", subject: "Incident OPENED: api availability" }]);
    expect(audit[0]).toEqual({ delivered: true, suppressedReason: null, recipient: "owner@acme.com" });
  });

  it("never sends when reliability is disabled, but still audits the suppression", async () => {
    const { pager, sends, audit } = makePager({}, { enabled: false });
    const r = await pager.page(pageInput());
    expect(r.delivered).toBe(false);
    expect(r.reason).toBe("disabled");
    expect(sends).toHaveLength(0);
    expect(audit[0].delivered).toBe(false);
    expect(audit[0].suppressedReason).toBe("disabled");
  });

  it("suppresses when the rate-limit window is full", async () => {
    const { pager, sends } = makePager({ recentPageCount: vi.fn(async () => 6) }, { maxPagesPerHour: 6 });
    const r = await pager.page(pageInput());
    expect(r.reason).toBe("rate_limited");
    expect(sends).toHaveLength(0);
  });

  it("cannot deliver without a verified owner contact (no_owner)", async () => {
    const { pager, sends, audit } = makePager({ ownerContact: vi.fn(async () => null) });
    const r = await pager.page(pageInput());
    expect(r).toEqual({ delivered: false, reason: "no_owner" });
    expect(sends).toHaveLength(0);
    expect(audit[0].delivered).toBe(false);
    expect(audit[0].suppressedReason).toBe("no_owner");
  });

  it("holds a warning page during quiet hours (decidePage drives it)", async () => {
    const { pager, sends } = makePager(
      { now: () => new Date("2026-06-11T03:00:00Z") },
      { quietHours: { startHourUtc: 22, endHourUtc: 6 } },
    );
    const r = await pager.page(pageInput({ severity: "warning" }));
    expect(r.reason).toBe("quiet_hours");
    expect(sends).toHaveLength(0);
  });
});
