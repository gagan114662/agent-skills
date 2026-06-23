import { describe, it, expect } from "vitest";
import {
  StandupDigestService,
  StandupDigestError,
  dayContaining,
  isoDay,
} from "../../src/standup-digest/service.js";
import { InMemoryStandupDigestStore } from "../../src/standup-digest/store.js";
import { StaticDailyActivitySource, FakeDailyActivitySource } from "../../src/standup-digest/source.js";
import type { StandupDigestCaps } from "../../src/standup-digest/caps.js";
import type { DailyActivityData } from "../../src/standup-digest/types.js";

/**
 * Unit tests of the service orchestration (#589): the disabled gate, generate/persist, idempotent daily tick,
 * and workspace-scoped reads — all with the in-memory store, the offline source, and an injected clock.
 */

const ENABLED: StandupDigestCaps = { enabled: true, maxItemsPerSection: 5 };
const DISABLED: StandupDigestCaps = { enabled: false, maxItemsPerSection: 5 };
const CLOCK = Date.UTC(2026, 5, 22, 9, 30); // 2026-06-22

function staticData(): DailyActivityData {
  return {
    workspaceId: "acme",
    period: { day: "2026-06-22" },
    agents: [
      {
        agentId: "writer",
        agentName: "Writer",
        role: "writer",
        artifacts: [{ id: "a1", title: "Drafted post", receipt: { label: "Doc", url: "/d/1" } }],
        decisions: [],
        blockers: [{ id: "b1", summary: "Awaiting review", severity: "high", receipt: { label: "T", url: "/t/1" } }],
        planned: [{ id: "p1", summary: "Publish post" }],
      },
    ],
  };
}

function makeService(caps: StandupDigestCaps, source = new FakeDailyActivitySource()) {
  return new StandupDigestService({
    store: new InMemoryStandupDigestStore(),
    dataSource: source,
    caps,
    now: () => new Date(CLOCK),
  });
}

describe("date helpers", () => {
  it("formats a UTC day with no timezone drift", () => {
    expect(isoDay(new Date(Date.UTC(2026, 0, 5, 23, 59)))).toBe("2026-01-05");
    expect(dayContaining(new Date(CLOCK))).toEqual({ day: "2026-06-22" });
  });
});

describe("StandupDigestService — disabled gate", () => {
  it("generateDigest throws when disabled", async () => {
    const svc = makeService(DISABLED);
    await expect(svc.generateDigest("acme", { day: "2026-06-22" })).rejects.toBeInstanceOf(StandupDigestError);
  });

  it("runScheduledDigest returns null when disabled (safe to call unconditionally)", async () => {
    const svc = makeService(DISABLED);
    expect(await svc.runScheduledDigest("acme")).toBeNull();
  });

  it("reports settings and enabled flag", () => {
    expect(makeService(ENABLED).enabled).toBe(true);
    expect(makeService(DISABLED).settings()).toEqual({ enabled: false, maxItemsPerSection: 5 });
  });
});

describe("StandupDigestService — generate + persist", () => {
  it("generates, synthesizes, and persists a digest for a specific day", async () => {
    const source = new StaticDailyActivitySource(new Map([["acme", staticData()]]));
    const svc = makeService(ENABLED, source);
    const rec = await svc.generateDigest("acme", { day: "2026-06-22" });

    expect(rec.id).toBe("acme:2026-06-22");
    expect(rec.workspaceId).toBe("acme");
    expect(rec.generatedAt).toEqual(new Date(CLOCK));
    expect(rec.digest.agents).toHaveLength(1);
    expect(rec.digest.agents[0]?.status).toBe("shipping"); // shipped an artifact
    expect(rec.digest.totals.blockers).toBe(1);
    expect(rec.digest.links.map((l) => l.url)).toEqual(["/d/1", "/t/1"]);

    const read = await svc.getDigest("acme", rec.id);
    expect(read).toEqual(rec);
  });

  it("upserts the same workspace-day (idempotent key, no duplicates)", async () => {
    const source = new StaticDailyActivitySource(new Map([["acme", staticData()]]));
    const svc = makeService(ENABLED, source);
    await svc.generateDigest("acme", { day: "2026-06-22" });
    await svc.generateDigest("acme", { day: "2026-06-22" });
    expect(await svc.listDigests("acme")).toHaveLength(1);
  });
});

describe("StandupDigestService — daily tick", () => {
  it("runScheduledDigest generates for the day containing now", async () => {
    const svc = makeService(ENABLED);
    const rec = await svc.runScheduledDigest("acme");
    expect(rec).not.toBeNull();
    expect(rec!.period.day).toBe("2026-06-22");
  });

  it("is idempotent: a second tick returns the stored digest unchanged", async () => {
    const svc = makeService(ENABLED);
    const first = await svc.runScheduledDigest("acme");
    const second = await svc.runScheduledDigest("acme");
    expect(second).toEqual(first);
    expect(await svc.listDigests("acme")).toHaveLength(1);
  });
});

describe("StandupDigestService — workspace-scoped reads (IDOR boundary)", () => {
  it("never returns another workspace's digest", async () => {
    const svc = makeService(ENABLED);
    const rec = await svc.runScheduledDigest("acme");
    expect(await svc.getDigest("other", rec!.id)).toBeNull();
    expect(await svc.listDigests("other")).toHaveLength(0);
    expect(await svc.latestDigest("other")).toBeNull();
  });

  it("latestDigest returns the newest day", async () => {
    const svc = makeService(ENABLED);
    await svc.generateDigest("acme", { day: "2026-06-20" });
    await svc.generateDigest("acme", { day: "2026-06-22" });
    await svc.generateDigest("acme", { day: "2026-06-21" });
    expect((await svc.latestDigest("acme"))!.period.day).toBe("2026-06-22");
  });
});
