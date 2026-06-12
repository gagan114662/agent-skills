import { describe, it, expect, vi } from "vitest";
import {
  FounderBriefingsService,
  dailyPeriodKey,
  weeklyPeriodKey,
  type DeliveryStore,
  type FounderBriefingsDeps,
} from "../../src/founder-briefings/service.js";
import { FounderBriefingsEngine } from "../../src/founder-briefings/engine.js";
import {
  MultiChannelBriefingNotifier,
  NoopSlackDeliverer,
  type BriefingDelivery,
  type BriefingNotifier,
  type SlackDeliverer,
} from "../../src/founder-briefings/notifier.js";
import { resolveBriefingsCaps, BRIEFINGS_DEFAULTS } from "../../src/founder-briefings/caps.js";
import { slackBriefingDeliverer } from "../../src/founder-briefings/default.js";
import type { SlackEventService } from "../../src/slack/service.js";

const NOW = new Date("2026-06-12T00:00:00Z");

/** An in-memory delivery audit store (the idempotency watermark + the send log). */
function memoryStore(): DeliveryStore & { rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    async wasDelivered(workspaceId, kind, periodKey) {
      return rows.some((r) => r.workspaceId === workspaceId && r.kind === kind && r.periodKey === periodKey);
    },
    async record(input) {
      if (await this.wasDelivered(input.workspaceId, input.kind, input.periodKey)) return; // unique
      rows.push({ ...input });
    },
  };
}

/** A capturing notifier — always "delivers" on email. */
function captureNotifier(): BriefingNotifier & { calls: BriefingDelivery[] } {
  const calls: BriefingDelivery[] = [];
  return {
    calls,
    async deliver(input) {
      calls.push(input);
      return { channels: [{ channel: "email", delivered: true, reason: "delivered" }], anyDelivered: true };
    },
  };
}

function buildDeps(over: Partial<FounderBriefingsDeps> = {}): FounderBriefingsDeps {
  return {
    caps: () => ({ ...BRIEFINGS_DEFAULTS, enabled: true }),
    brandName: "ipop",
    ships: { shipped: async () => [{ title: "Ship A", ref: "pr-1" }] },
    blocks: { blocked: async () => [] },
    decisions: { items: async () => [] },
    spend: {
      window: () => "2026-06",
      usage: async () => ({ estimatedCostCents: 100 }),
      budgetCents: () => 1000,
      currency: () => "usd",
    },
    constitution: { summary: async () => ({ open: 0, topCodes: [] }) },
    ventures: { ventures: async () => [] },
    revenue: { total: async () => ({ totalCents: 0, currency: "usd" }) },
    voice: { signals: async () => [] },
    backlog: { upcoming: async () => [] },
    notifier: captureNotifier(),
    deliveries: memoryStore(),
    now: () => NOW,
    ...over,
  };
}

describe("period keys", () => {
  it("daily key is the UTC calendar date", () => {
    expect(dailyPeriodKey(new Date("2026-06-12T23:59:00Z"))).toBe("2026-06-12");
  });
  it("weekly key is the ISO week", () => {
    // 2026-06-12 is a Friday in ISO week 24.
    expect(weeklyPeriodKey(new Date("2026-06-12T00:00:00Z"))).toBe("2026-W24");
    // 2026-01-01 is a Thursday → ISO week 1.
    expect(weeklyPeriodKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
  });
});

describe("resolveBriefingsCaps", () => {
  it("defaults OFF with a 200-word daily budget", () => {
    const caps = resolveBriefingsCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps.daily).toBe(true);
    expect(caps.maxBriefWords).toBe(200);
  });
  it("a higher layer can enable + override thresholds", () => {
    const caps = resolveBriefingsCaps({ enabled: true, staleLevel1Hours: 6, maxBriefWords: 150 });
    expect(caps.enabled).toBe(true);
    expect(caps.staleLevel1Hours).toBe(6);
    expect(caps.maxBriefWords).toBe(150);
  });
});

describe("FounderBriefingsService delivery gating", () => {
  it("skips delivery when the caps flag is OFF and records nothing", async () => {
    const store = memoryStore();
    const notifier = captureNotifier();
    const svc = new FounderBriefingsService(
      buildDeps({ caps: () => ({ ...BRIEFINGS_DEFAULTS, enabled: false }), deliveries: store, notifier }),
    );
    const out = await svc.deliverDaily("ws");
    expect(out.status).toBe("skipped_disabled");
    expect(notifier.calls).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("delivers once, then dedups on the watermark (idempotent)", async () => {
    const store = memoryStore();
    const notifier = captureNotifier();
    const svc = new FounderBriefingsService(buildDeps({ deliveries: store, notifier }));

    const first = await svc.deliverDaily("ws");
    expect(first.status).toBe("sent");
    expect(first.delivery?.anyDelivered).toBe(true);
    expect(notifier.calls).toHaveLength(1);
    expect(store.rows).toHaveLength(1);

    const second = await svc.deliverDaily("ws");
    expect(second.status).toBe("skipped_already_sent");
    expect(notifier.calls).toHaveLength(1); // not re-delivered
    expect(store.rows).toHaveLength(1);
  });

  it("respects the weekly toggle independently", async () => {
    const svc = new FounderBriefingsService(
      buildDeps({ caps: () => ({ ...BRIEFINGS_DEFAULTS, enabled: true, weekly: false }) }),
    );
    expect((await svc.deliverWeekly("ws")).status).toBe("skipped_disabled");
    expect((await svc.deliverDaily("ws")).status).toBe("sent");
  });

  it("records the rendered word count + channel audit on send", async () => {
    const store = memoryStore();
    const svc = new FounderBriefingsService(buildDeps({ deliveries: store }));
    await svc.deliverDaily("ws");
    expect(store.rows[0]!.delivered).toBe(true);
    expect(typeof store.rows[0]!.wordCount).toBe("number");
    expect(store.rows[0]!.kind).toBe("daily");
  });
});

describe("FounderBriefingsEngine tick", () => {
  it("delivers both digests for every workspace and dedups a second tick in the same period", async () => {
    const store = memoryStore();
    const notifier = captureNotifier();
    const svc = new FounderBriefingsService(buildDeps({ deliveries: store, notifier }));
    const engine = new FounderBriefingsEngine({
      service: svc,
      listWorkspaceIds: async () => ["ws-1", "ws-2"],
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), child: vi.fn() } as never,
      now: () => NOW,
    });

    await engine.tickAll();
    expect(notifier.calls).toHaveLength(4); // 2 workspaces × (daily + weekly)

    await engine.tickAll(); // same period → all watermarked
    expect(notifier.calls).toHaveLength(4);
  });

  it("skips the whole pass under maintenance", async () => {
    const svc = new FounderBriefingsService(buildDeps());
    const listWorkspaceIds = vi.fn(async () => ["ws-1"]);
    const engine = new FounderBriefingsEngine({
      service: svc,
      listWorkspaceIds,
      maintenancePaused: async () => true,
      logger: { warn: vi.fn(), error: vi.fn() } as never,
      now: () => NOW,
    });
    await engine.tickAll();
    expect(listWorkspaceIds).not.toHaveBeenCalled();
  });
});

describe("MultiChannelBriefingNotifier", () => {
  const delivery: BriefingDelivery = { workspaceId: "ws", kind: "daily", subject: "s", body: "b" };

  it("emails the resolved owner and reports the no-op Slack channel", async () => {
    const send = vi.fn(async () => {});
    const notifier = new MultiChannelBriefingNotifier({
      ownerContact: { resolve: async () => ({ email: "owner@x.com" }) },
      transport: { send },
      slack: new NoopSlackDeliverer(),
    });
    const out = await notifier.deliver(delivery);
    expect(send).toHaveBeenCalledWith({ to: "owner@x.com", subject: "s", body: "b" });
    expect(out.channels).toEqual([
      { channel: "email", delivered: true, reason: "delivered" },
      { channel: "slack", delivered: false, reason: "not_connected" },
    ]);
    expect(out.anyDelivered).toBe(true);
  });

  it("audits no_owner when the workspace has no verified owner", async () => {
    const notifier = new MultiChannelBriefingNotifier({
      ownerContact: { resolve: async () => null },
      transport: { send: vi.fn(async () => {}) },
    });
    const out = await notifier.deliver(delivery);
    expect(out.channels[0]).toEqual({ channel: "email", delivered: false, reason: "no_owner" });
    expect(out.anyDelivered).toBe(false);
  });

  it("captures a transport error as a channel result, never throws", async () => {
    const notifier = new MultiChannelBriefingNotifier({
      ownerContact: { resolve: async () => ({ email: "owner@x.com" }) },
      transport: { send: vi.fn(async () => { throw new Error("smtp down"); }) },
    });
    const out = await notifier.deliver(delivery);
    expect(out.channels[0]).toEqual({ channel: "email", delivered: false, reason: "transport_error" });
  });

  it("the real #170 deliverer maps sendOwnerDm onto the channel result", async () => {
    const connected = slackBriefingDeliverer({
      sendOwnerDm: async (wid: string, msg: { text: string }) => {
        expect(wid).toBe("ws");
        expect(msg.text).toBe("b");
        return { sent: true };
      },
    } as unknown as SlackEventService);
    expect(await connected.deliver({ ...delivery, ownerEmail: null })).toEqual({
      channel: "slack",
      delivered: true,
      reason: "dm_sent",
    });

    const notConnected = slackBriefingDeliverer({
      sendOwnerDm: async () => ({ sent: false }),
    } as unknown as SlackEventService);
    expect(await notConnected.deliver({ ...delivery, ownerEmail: null })).toEqual({
      channel: "slack",
      delivered: false,
      reason: "not_connected",
    });
  });

  it("delivers through an injected Slack channel when connected (#170 seam)", async () => {
    const slack: SlackDeliverer = {
      deliver: async (input) => {
        expect(input.ownerEmail).toBe("owner@x.com");
        return { channel: "slack", delivered: true, reason: "dm_sent" };
      },
    };
    const notifier = new MultiChannelBriefingNotifier({
      ownerContact: { resolve: async () => ({ email: "owner@x.com" }) },
      transport: { send: vi.fn(async () => {}) },
      slack,
    });
    const out = await notifier.deliver(delivery);
    expect(out.channels[1]).toEqual({ channel: "slack", delivered: true, reason: "dm_sent" });
  });
});
