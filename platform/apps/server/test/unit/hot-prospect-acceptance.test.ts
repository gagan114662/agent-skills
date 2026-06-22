import { describe, it, expect } from "vitest";
import { HotProspectService } from "../../src/hot-prospect/service.js";
import { InMemoryAlertStore } from "../../src/hot-prospect/store.js";
import { RecordingApprovalGate, RecordingNotifier } from "../../src/hot-prospect/notify.js";
import { FixtureSignalSource, simulateHighIntent } from "../../src/hot-prospect/source.js";
import { resolveHotProspectPolicy } from "../../src/hot-prospect/caps.js";

const WID = "ws-1";
const NOW = Date.parse("2026-06-22T12:00:00.000Z");

/**
 * Issue #622 acceptance: "a simulated high-intent pattern fires an alert and queues a tailored follow-up."
 * Plus the trust boundary: the outbound notification stays behind the approval queue (sends nothing until a
 * human approves), and the whole thing is DEFAULT-OFF.
 */
describe("hot-prospect alerting — #622 acceptance", () => {
  function build(enabled: boolean) {
    // Governed model from the real env-resolved policy; flip only the master switch.
    const policy = resolveHotProspectPolicy(enabled ? { HOT_PROSPECT_ALERTING_ENABLED: "1" } : {});
    // The named pattern: "visited pricing 3x today".
    const visitedPricing3x = simulateHighIntent({
      prospectId: "acme-co",
      label: "Acme Co",
      kind: "pricing_view",
      repeat: 3,
      endMs: NOW,
      gapMinutes: 90,
      detail: "/pricing",
    });
    const notifier = new RecordingNotifier();
    const gate = new RecordingApprovalGate(notifier);
    const service = new HotProspectService({
      source: new FixtureSignalSource({ [WID]: [visitedPricing3x] }),
      store: new InMemoryAlertStore(),
      gate,
      policy,
      now: () => new Date(NOW),
    });
    return { service, gate, notifier };
  }

  it("is inert when disabled (the shipped default)", async () => {
    const { service, gate, notifier } = build(false);
    const res = await service.scan(WID);
    expect(res.enabled).toBe(false);
    expect(res.alerts).toHaveLength(0);
    expect(gate.pending).toHaveLength(0);
    expect(notifier.delivered).toHaveLength(0);
  });

  it("fires an alert with a tailored follow-up, parked behind the approval queue", async () => {
    const { service, gate, notifier } = build(true);
    const res = await service.scan(WID);

    // Fires exactly one alert for the high-intent prospect.
    expect(res.alerts).toHaveLength(1);
    const { alert, approvalRequestId } = res.alerts[0]!;
    expect(alert.prospectId).toBe("acme-co");
    expect(alert.label).toBe("Acme Co");
    expect(alert.reason.toLowerCase()).toContain("pricing");
    expect(alert.firedRules[0]).toMatchObject({ kind: "pricing_view", count: 3, threshold: 3 });

    // Queues a TAILORED follow-up — tailored to the pricing trigger, addressed to the prospect.
    expect(alert.followUp.basedOn).toBe("pricing_view");
    expect(alert.followUp.subject.toLowerCase()).toContain("pricing");
    expect(alert.followUp.body).toContain("Acme Co");
    expect(alert.followUp.channel).toBe("email");

    // Routed to the outreach agent + the user — but PARKED, not sent.
    expect(alert.routes).toEqual(["outreach_agent", "user"]);
    expect(gate.pending).toHaveLength(1);
    expect(gate.pending[0]!.status).toBe("pending");
    expect(approvalRequestId).toBe(gate.pending[0]!.approvalRequestId);
    expect(notifier.delivered).toHaveLength(0);

    // The notification goes out only after a human approves the parked request.
    const receipts = await gate.approve(approvalRequestId);
    expect(receipts.map((r) => r.route)).toEqual(["outreach_agent", "user"]);
    expect(notifier.delivered).toHaveLength(2);
  });
});
