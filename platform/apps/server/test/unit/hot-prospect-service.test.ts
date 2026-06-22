import { describe, it, expect } from "vitest";
import { HotProspectService } from "../../src/hot-prospect/service.js";
import { InMemoryAlertStore } from "../../src/hot-prospect/store.js";
import { RecordingApprovalGate, RecordingNotifier } from "../../src/hot-prospect/notify.js";
import { FixtureSignalSource, simulateHighIntent } from "../../src/hot-prospect/source.js";
import type { SignalSource } from "../../src/hot-prospect/source.js";
import type { HotProspectPolicy, IntentRule } from "../../src/hot-prospect/caps.js";
import type { ProspectActivity } from "../../src/hot-prospect/types.js";

const WID = "ws-1";
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-06-22T12:00:00.000Z");

const RULES: readonly IntentRule[] = [
  { kind: "pricing_view", label: "Pricing", weight: 10, saturateAt: 3, burstThreshold: 3 },
  { kind: "site_visit", label: "Site", weight: 1, saturateAt: 6, burstThreshold: 0 },
];

function policy(overrides: Partial<HotProspectPolicy> = {}): HotProspectPolicy {
  return {
    enabled: true,
    windowMs: 24 * HOUR,
    scoreThreshold: 20,
    cooldownMs: 24 * HOUR,
    rules: RULES,
    ...overrides,
  };
}

function clock(startMs = NOW) {
  let t = startMs;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

/** A hot prospect: 3 pricing views in the window (fires the burst rule). */
function hotProspect(prospectId = "p-hot", label = "Acme", endMs = NOW): ProspectActivity {
  return simulateHighIntent({ prospectId, label, kind: "pricing_view", repeat: 3, endMs });
}

function build(opts: { caps?: HotProspectPolicy; source?: SignalSource; nowFn?: () => Date } = {}) {
  const store = new InMemoryAlertStore();
  const notifier = new RecordingNotifier();
  const gate = new RecordingApprovalGate(notifier);
  const source = opts.source ?? new FixtureSignalSource({ [WID]: [hotProspect()] });
  const service = new HotProspectService({
    source,
    store,
    gate,
    policy: opts.caps ?? policy(),
    now: opts.nowFn ?? (() => new Date(NOW)),
  });
  return { service, store, notifier, gate, source };
}

describe("HotProspectService — disabled (default)", () => {
  it("is inert: no alerts, no source read, no parked approval, no send", async () => {
    let reads = 0;
    const countingSource: SignalSource = {
      async recentActivity() {
        reads++;
        return [hotProspect()];
      },
    };
    const { service, gate, notifier } = build({ caps: policy({ enabled: false }), source: countingSource });
    const res = await service.scan(WID);
    expect(res.enabled).toBe(false);
    expect(res.alerts).toEqual([]);
    expect(reads).toBe(0);
    expect(gate.pending).toHaveLength(0);
    expect(notifier.delivered).toHaveLength(0);
    expect(await service.recentAlerts(WID)).toEqual([]);
  });
});

describe("HotProspectService — scan fires gated alerts", () => {
  it("raises an alert, parks an approval, and sends NOTHING", async () => {
    const { service, store, gate, notifier } = build();
    const res = await service.scan(WID);

    expect(res.enabled).toBe(true);
    expect(res.alerts).toHaveLength(1);
    const raised = res.alerts[0]!;
    expect(raised.alert.prospectId).toBe("p-hot");
    expect(raised.alert.routes).toEqual(["outreach_agent", "user"]);
    expect(raised.approvalRequestId).toBe(gate.pending[0]!.approvalRequestId);

    // Parked, not sent: the gate holds a pending request; the notifier has delivered nothing.
    expect(gate.pending).toHaveLength(1);
    expect(gate.pending[0]!.status).toBe("pending");
    expect(notifier.delivered).toHaveLength(0);

    // Persisted with the approval id (proof the send is gated).
    const stored = await store.recent(WID);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.approvalRequestId).toBe(raised.approvalRequestId);
  });

  it("delivers ONLY after a human approves the parked request", async () => {
    const { service, gate, notifier } = build();
    const { alerts } = await service.scan(WID);
    const id = alerts[0]!.approvalRequestId;

    expect(notifier.delivered).toHaveLength(0); // still nothing before approval
    const receipts = await gate.approve(id);
    expect(receipts.map((r) => r.route)).toEqual(["outreach_agent", "user"]);
    expect(notifier.delivered).toHaveLength(2);
    expect(gate.find(id)!.status).toBe("approved");

    // Idempotent: re-approving does not re-deliver.
    await gate.approve(id);
    expect(notifier.delivered).toHaveLength(2);
  });

  it("never delivers a rejected request", async () => {
    const { service, gate, notifier } = build();
    const { alerts } = await service.scan(WID);
    const id = alerts[0]!.approvalRequestId;
    gate.reject(id);
    expect(await gate.approve(id)).toEqual([]);
    expect(notifier.delivered).toHaveLength(0);
  });

  it("does not alert a cold prospect", async () => {
    const cold: ProspectActivity = { prospectId: "p-cold", signals: [{ kind: "site_visit", at: new Date(NOW).toISOString() }] };
    const { service, gate } = build({ source: new FixtureSignalSource({ [WID]: [cold] }) });
    const res = await service.scan(WID);
    expect(res.alerts).toHaveLength(0);
    expect(gate.pending).toHaveLength(0);
  });
});

describe("HotProspectService — cooldown dedup", () => {
  it("does not re-fire a still-hot prospect within the cooldown window", async () => {
    const c = clock();
    const source = new FixtureSignalSource({ [WID]: [hotProspect("p-hot", "Acme", c.now().getTime())] });
    const store = new InMemoryAlertStore();
    const gate = new RecordingApprovalGate();
    const service = new HotProspectService({ source, store, gate, policy: policy(), now: c.now });

    const first = await service.scan(WID);
    expect(first.alerts).toHaveLength(1);

    // Same hot activity an hour later — inside the 24h cooldown, so no second alert.
    c.advance(HOUR);
    source.set(WID, [hotProspect("p-hot", "Acme", c.now().getTime())]);
    const second = await service.scan(WID);
    expect(second.alerts).toHaveLength(0);
    expect(gate.pending).toHaveLength(1);
  });

  it("re-fires once the cooldown has elapsed", async () => {
    const c = clock();
    const source = new FixtureSignalSource({ [WID]: [hotProspect("p-hot", "Acme", c.now().getTime())] });
    const store = new InMemoryAlertStore();
    const gate = new RecordingApprovalGate();
    const service = new HotProspectService({ source, store, gate, policy: policy({ cooldownMs: 2 * HOUR }), now: c.now });

    await service.scan(WID);
    c.advance(3 * HOUR); // past the 2h cooldown
    source.set(WID, [hotProspect("p-hot", "Acme", c.now().getTime())]);
    const again = await service.scan(WID);
    expect(again.alerts).toHaveLength(1);
    expect(gate.pending).toHaveLength(2);
  });
});

describe("HotProspectService — read-back", () => {
  it("exposes recent alerts newest-first", async () => {
    const two: ProspectActivity[] = [
      hotProspect("p-a", "A", NOW),
      hotProspect("p-b", "B", NOW),
    ];
    const { service } = build({ source: new FixtureSignalSource({ [WID]: two }) });
    await service.scan(WID);
    const recent = await service.recentAlerts(WID);
    expect(recent).toHaveLength(2);
    expect(new Set(recent.map((r) => r.prospectId))).toEqual(new Set(["p-a", "p-b"]));
  });
});
