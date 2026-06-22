import { describe, it, expect } from "vitest";
import {
  MemoryGraphService,
  MemoryGraphError,
} from "../../src/memory-graph/service.js";
import { InMemoryGraphStore } from "../../src/memory-graph/store.js";
import type { MemoryGraphCaps } from "../../src/memory-graph/caps.js";

const WID = "ws-1";
const ENABLED: MemoryGraphCaps = { enabled: true, recallFreshnessMs: 30 * 24 * 60 * 60 * 1000 };
const DISABLED: MemoryGraphCaps = { enabled: false, recallFreshnessMs: 30 * 24 * 60 * 60 * 1000 };

/** A mutable clock so freshness windows are testable without wall-clock time. */
function clock(startMs = 1_000_000) {
  let t = startMs;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

function makeService(caps: MemoryGraphCaps = ENABLED, now: () => Date = () => new Date(1_000_000)) {
  const store = new InMemoryGraphStore();
  const service = new MemoryGraphService({ store, caps, now });
  return { store, service };
}

describe("MemoryGraphService — record + dedup (write-after-act)", () => {
  it("records a new fact as created", async () => {
    const { service } = makeService();
    const r = await service.record(WID, { kind: "research", subject: "growth loops", value: "referral wins" });
    expect(r.created).toBe(true);
    expect(r.node.kind).toBe("research");
    expect(r.node.observations).toHaveLength(1);
  });

  it("dedups a re-asserted fact onto the existing node and appends an observation", async () => {
    const { service } = makeService();
    await service.record(WID, { kind: "research", subject: "growth loops", value: "Referral wins", byAgent: "a1" });
    const second = await service.record(WID, {
      kind: "research",
      subject: "growth   LOOPS",
      value: "referral   wins",
      byAgent: "a2",
    });
    expect(second.created).toBe(false);
    expect(second.node.observations).toHaveLength(2);
    expect(second.node.observations.map((o) => o.byAgent)).toEqual(["a1", "a2"]);
  });

  it("validates required fields", async () => {
    const { service } = makeService();
    await expect(service.record(WID, { kind: "note", subject: "  ", value: "x" })).rejects.toBeInstanceOf(
      MemoryGraphError,
    );
    await expect(service.record(WID, { kind: "note", subject: "s", value: "" })).rejects.toBeInstanceOf(
      MemoryGraphError,
    );
  });
});

describe("MemoryGraphService — recall (read-before-act, AC1)", () => {
  it("surfaces prior work on a subject instead of nothing", async () => {
    const { service } = makeService();
    await service.record(WID, { kind: "prospect", subject: "Acme Corp", value: "ICP fit, 200 staff" });
    const recall = await service.recall(WID, { subject: "acme corp", kind: "prospect" });
    expect(recall.hasPriorWork).toBe(true);
    expect(recall.priorWork[0]?.value).toContain("ICP fit");
  });

  it("returns no prior work for an unseen subject", async () => {
    const { service } = makeService();
    const recall = await service.recall(WID, { subject: "never researched" });
    expect(recall.hasPriorWork).toBe(false);
  });

  it("hides stale work past the freshness window but can include it on request", async () => {
    const c = clock();
    const { store } = makeService(ENABLED, c.now);
    const service = new MemoryGraphService({ store, caps: ENABLED, now: c.now });
    await service.record(WID, { kind: "research", subject: "old topic", value: "stale finding" });
    c.advance(ENABLED.recallFreshnessMs + 1);
    expect((await service.recall(WID, { subject: "old topic" })).hasPriorWork).toBe(false);
    expect((await service.recall(WID, { subject: "old topic", includeStale: true })).hasPriorWork).toBe(true);
  });

  it("excludes superseded nodes from recall", async () => {
    const { service } = makeService();
    const r = await service.record(WID, { kind: "claim", subject: "Acme", predicate: "status", value: "lead" });
    await service.supersede(WID, r.node.id);
    expect((await service.recall(WID, { subject: "Acme" })).hasPriorWork).toBe(false);
  });
});

describe("MemoryGraphService — conflicts (pre-publish AC2 + write-time)", () => {
  it("checkConflicts flags a contradicting claim WITHOUT writing it", async () => {
    const { service, store } = makeService();
    await service.record(WID, { kind: "claim", subject: "Acme", predicate: "pricing_model", value: "usage-based" });
    const conflicts = await service.checkConflicts(WID, {
      kind: "claim",
      subject: "Acme",
      predicate: "pricing_model",
      value: "seat-based",
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.existingValue).toBe("usage-based");
    // nothing persisted by the check
    expect(await store.queryNodes(WID, { subjectKey: "acme", status: "active" })).toHaveLength(1);
  });

  it("checkConflicts returns [] for an agreeing claim and for findings", async () => {
    const { service } = makeService();
    await service.record(WID, { kind: "claim", subject: "Acme", predicate: "pricing_model", value: "usage-based" });
    expect(
      await service.checkConflicts(WID, { kind: "claim", subject: "Acme", predicate: "pricing_model", value: "usage-based" }),
    ).toHaveLength(0);
    expect(
      await service.checkConflicts(WID, { kind: "research", subject: "Acme", value: "no predicate here" }),
    ).toHaveLength(0);
  });

  it("record surfaces the conflict it introduces but still lands the write", async () => {
    const { service, store } = makeService();
    await service.record(WID, { kind: "claim", subject: "Acme", predicate: "pricing_model", value: "usage-based" });
    const r = await service.record(WID, { kind: "claim", subject: "Acme", predicate: "pricing_model", value: "seat-based" });
    expect(r.conflicts).toHaveLength(1);
    expect(r.created).toBe(true);
    expect(await store.queryNodes(WID, { subjectKey: "acme", status: "active" })).toHaveLength(2);
  });

  it("a re-asserted identical claim never conflicts with itself", async () => {
    const { service } = makeService();
    await service.record(WID, { kind: "claim", subject: "Acme", predicate: "pricing_model", value: "usage-based" });
    const again = await service.record(WID, { kind: "claim", subject: "Acme", predicate: "pricing_model", value: "usage-based" });
    expect(again.conflicts).toHaveLength(0);
    expect(again.created).toBe(false);
  });
});

describe("MemoryGraphService — edges / relationships", () => {
  it("links two nodes and reads them back as neighbors", async () => {
    const { service } = makeService();
    const prospect = await service.record(WID, { kind: "prospect", subject: "Acme", value: "fit" });
    const channel = await service.record(WID, { kind: "channel", subject: "LinkedIn", value: "outbound" });
    const edge = await service.link(WID, prospect.node.id, channel.node.id, "reached_via");
    expect(edge.relation).toBe("reached_via");
    const neighbors = await service.neighbors(WID, prospect.node.id);
    expect(neighbors.map((n) => n.subject)).toContain("LinkedIn");
  });

  it("rejects self-edges and edges to non-existent nodes", async () => {
    const { service } = makeService();
    const a = await service.record(WID, { kind: "prospect", subject: "Acme", value: "fit" });
    await expect(service.link(WID, a.node.id, a.node.id, "rel")).rejects.toBeInstanceOf(MemoryGraphError);
    await expect(service.link(WID, a.node.id, "missing", "rel")).rejects.toBeInstanceOf(MemoryGraphError);
  });
});

describe("MemoryGraphService — workspace scoping (#3 IDOR)", () => {
  it("recall, get, and conflict checks never cross workspaces", async () => {
    const { service } = makeService();
    const r = await service.record("ws-A", { kind: "claim", subject: "Acme", predicate: "pricing_model", value: "usage-based" });
    expect((await service.recall("ws-B", { subject: "Acme" })).hasPriorWork).toBe(false);
    expect(await service.get("ws-B", r.node.id)).toBeNull();
    expect(
      await service.checkConflicts("ws-B", { kind: "claim", subject: "Acme", predicate: "pricing_model", value: "seat-based" }),
    ).toHaveLength(0);
  });
});

describe("MemoryGraphService — disabled (MEMORY_GRAPH_ENABLED=0)", () => {
  it("is inert: recall empty, record not persisted, conflicts empty", async () => {
    const { service, store } = makeService(DISABLED);
    const r = await service.record(WID, { kind: "claim", subject: "Acme", predicate: "pricing_model", value: "x" });
    expect(r.created).toBe(false);
    expect((await service.recall(WID, { subject: "Acme" })).hasPriorWork).toBe(false);
    expect(await service.checkConflicts(WID, { kind: "claim", subject: "Acme", predicate: "pricing_model", value: "y" })).toHaveLength(0);
    expect(await store.queryNodes(WID, { status: "any" })).toHaveLength(0);
  });
});

describe("MemoryGraphService — concurrency", () => {
  it("collapses a burst of concurrent identical writes to ONE node (no duplicate research)", async () => {
    const { service, store } = makeService();
    const writes = Array.from({ length: 25 }, (_, i) =>
      service.record(WID, { kind: "research", subject: "growth loops", value: "referral wins", byAgent: `agent-${i}` }),
    );
    const results = await Promise.all(writes);

    // Exactly one creator; everyone else deduped.
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const nodes = await store.queryNodes(WID, { subjectKey: "growth loops", status: "active" });
    expect(nodes).toHaveLength(1);
    // Every concurrent caller's observation is preserved on the single node.
    expect(nodes[0]?.observations).toHaveLength(25);
  });

  it("serves concurrent reads consistently while writes interleave", async () => {
    const { service } = makeService();
    await service.record(WID, { kind: "prospect", subject: "Acme", value: "seed" });
    const ops = [
      service.recall(WID, { subject: "Acme" }),
      service.record(WID, { kind: "prospect", subject: "Acme", value: "seed" }), // dedup
      service.recall(WID, { subject: "Acme" }),
      service.record(WID, { kind: "channel", subject: "Acme", value: "new finding" }), // distinct node
      service.recall(WID, { subject: "Acme" }),
    ];
    const settled = await Promise.allSettled(ops);
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    // After everything settles, the subject has exactly the two distinct nodes.
    const final = await service.recall(WID, { subject: "Acme" });
    expect(final.priorWork).toHaveLength(2);
  });

  it("detects a contradiction between two concurrently-recorded claims", async () => {
    const { service } = makeService();
    // Two agents publish conflicting claims about the same attribute at the same time.
    await Promise.all([
      service.record(WID, { kind: "claim", subject: "Acme", predicate: "pricing_model", value: "usage-based", byAgent: "a1" }),
      service.record(WID, { kind: "claim", subject: "Acme", predicate: "pricing_model", value: "seat-based", byAgent: "a2" }),
    ]);
    // Both landed as distinct nodes; a subsequent pre-publish check sees the disagreement.
    const conflicts = await service.checkConflicts(WID, {
      kind: "claim",
      subject: "Acme",
      predicate: "pricing_model",
      value: "tiered",
    });
    expect(conflicts.length).toBeGreaterThanOrEqual(2);
  });
});
