import { describe, it, expect } from "vitest";
import {
  composeVentureBrief,
  ideaIdFromEntity,
  slugify,
  toVentureEntry,
  ventureEntity,
  ventureMemoryContent,
  ventureMemoryDedupeKey,
  type RawVentureNode,
} from "../../src/venture-memory/memory.js";
import type { OkrDrift } from "../../src/venture-memory/okr.js";
import type { VentureMemoryEntry } from "../../src/venture-memory/types.js";

describe("venture memory encoding/decoding (reuses the #15 memories table)", () => {
  it("round-trips the venture entity key", () => {
    expect(ventureEntity("idea_42")).toBe("venture:idea_42");
    expect(ideaIdFromEntity("venture:idea_42")).toBe("idea_42");
    expect(ideaIdFromEntity("task:idea_42")).toBeNull();
    expect(ideaIdFromEntity(null)).toBeNull();
  });

  it("dedupe key is stable per (venture, kind, statement)", () => {
    const a = ventureMemoryDedupeKey("idea_1", "decision", "We chose Stripe for billing");
    const b = ventureMemoryDedupeKey("idea_1", "decision", "We chose Stripe for billing");
    expect(a).toBe(b);
    expect(a).toContain("vm:idea_1:decision:");
  });

  it("content carries text+kind and only includes why/sourceRef when present", () => {
    expect(ventureMemoryContent({ kind: "worked", text: "cold email worked" })).toEqual({
      text: "cold email worked",
      kind: "worked",
    });
    expect(
      ventureMemoryContent({ kind: "decision", text: "drop free tier", why: "abuse", sourceRef: "msg_1" }),
    ).toEqual({ text: "drop free tier", kind: "decision", why: "abuse", sourceRef: "msg_1" });
  });

  it("decodes a well-formed node and rejects a malformed one", () => {
    const node: RawVentureNode = {
      id: "m_1",
      content: { text: "drop free tier", kind: "decision", why: "abuse" },
      entity: "venture:idea_1",
      createdAtMs: 123,
      stale: false,
    };
    expect(toVentureEntry(node)).toEqual({
      id: "m_1",
      ideaId: "idea_1",
      kind: "decision",
      text: "drop free tier",
      why: "abuse",
      sourceRef: null,
      createdAtMs: 123,
      stale: false,
    });
    expect(toVentureEntry({ ...node, content: { text: "x", kind: "nope" } })).toBeNull();
    expect(toVentureEntry({ ...node, entity: null })).toBeNull();
  });

  it("slugify is ascii-safe and bounded", () => {
    expect(slugify("Hello, World!  Again")).toBe("hello-world-again");
  });
});

describe("composeVentureBrief: the session-context injection (AC1)", () => {
  const mem = (kind: VentureMemoryEntry["kind"], text: string, over: Partial<VentureMemoryEntry> = {}): VentureMemoryEntry => ({
    id: text,
    ideaId: "idea_1",
    kind,
    text,
    why: null,
    sourceRef: null,
    createdAtMs: 0,
    stale: false,
    ...over,
  });

  it("returns '' for a brand-new venture (nothing to inject)", () => {
    expect(composeVentureBrief({ ideaId: "idea_1", memories: [], okrDrift: [], maxPerKind: 5 })).toBe("");
  });

  it("groups by kind, renders decision 'why', and flags OKR drift", () => {
    const okrDrift: OkrDrift[] = [
      {
        okrId: "o1",
        ideaId: "idea_1",
        objective: "Reach PMF",
        keyResults: [
          { metric: "MRR", target: 1000, current: 300, unit: "usd", verified: false, source: null, progress: 0.3, status: "unverified" },
        ],
        drifting: true,
        verifiedCount: 0,
        totalCount: 1,
      },
    ];
    const brief = composeVentureBrief({
      ideaId: "idea_1",
      memories: [
        mem("decision", "drop free tier", { why: "abuse" }),
        mem("customer_voice", "users want CSV"),
      ],
      okrDrift,
      maxPerKind: 5,
    });
    expect(brief).toContain("# Venture memory (idea_1)");
    expect(brief).toContain("## OKRs");
    expect(brief).toContain("⚠ DRIFT");
    expect(brief).toContain("MRR 300/1000 [unverified]");
    expect(brief).toContain("Decisions (and why)");
    expect(brief).toContain("drop free tier — because abuse");
    expect(brief).toContain("Customer voice");
  });

  it("bounds memories per kind by maxPerKind", () => {
    const brief = composeVentureBrief({
      ideaId: "idea_1",
      memories: [mem("worked", "a"), mem("worked", "b"), mem("worked", "c")],
      okrDrift: [],
      maxPerKind: 2,
    });
    expect(brief).toContain("- a");
    expect(brief).toContain("- b");
    expect(brief).not.toContain("- c");
  });
});
