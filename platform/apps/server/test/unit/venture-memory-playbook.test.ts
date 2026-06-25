import { describe, it, expect } from "vitest";
import {
  distillPlaybook,
  matchPlaybooks,
  ventureHash,
  type PlaybookWin,
} from "../../src/venture-memory/playbook.js";
import type { PlaybookRecord } from "../../src/venture-memory/types.js";

function win(over: Partial<PlaybookWin> = {}): PlaybookWin {
  return {
    ideaId: "idea_1",
    category: "launch",
    segment: "b2b",
    targetUser: "Mid-market RevOps teams",
    pattern: "Launch on ProductHunt on a Tuesday",
    outcome: "300 signups in 24h",
    evidence: "analytics export",
    verifierResultId: "vr_55",
    ...over,
  };
}

describe("ventureHash: deterministic, anonymizing", () => {
  it("is stable and 8 hex chars", () => {
    expect(ventureHash("idea_1")).toBe(ventureHash("idea_1"));
    expect(ventureHash("idea_1")).toMatch(/^[0-9a-f]{8}$/);
    expect(ventureHash("idea_1")).not.toBe(ventureHash("idea_2"));
  });
});

describe("distillPlaybook: requires a #106 receipt + anonymizes", () => {
  it("refuses a win with no verifier receipt (un-receipted win is fiction)", () => {
    expect(distillPlaybook(win({ verifierResultId: null }))).toBeNull();
  });

  it("refuses a pattern that leaks the venture id", () => {
    expect(distillPlaybook(win({ pattern: "do the idea_1 thing" }))).toBeNull();
  });

  it("distills an anonymized, provenance-bearing, dedupe-keyed playbook", () => {
    const pb = distillPlaybook(win())!;
    expect(pb).not.toBeNull();
    expect(pb.pattern).not.toContain("idea_1");
    expect(pb.provenance[0]!.sourceVentureHash).toBe(ventureHash("idea_1"));
    expect(pb.provenance[0]!.segment).toBe("b2b");
    expect(pb.provenance[0]!.targetUser).toBe("mid-market revops teams");
    expect(pb.provenance[0]!.verifierResultId).toBe("vr_55");
    expect(pb.dedupeKey).toContain("pb:launch:");
  });
});

describe("matchPlaybooks: same-category first, excludes self-only", () => {
  const rec = (over: Partial<PlaybookRecord>): PlaybookRecord => ({
    id: "pb",
    workspaceId: "ws_1",
    category: "growth",
    pattern: "p",
    provenance: [
      {
        sourceVentureHash: ventureHash("idea_9"),
        segment: null,
        targetUser: null,
        outcome: "o",
        evidence: "e",
        verifierResultId: "vr",
      },
    ],
    dedupeKey: "k",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  });

  it("ranks same-category playbooks ahead of others", () => {
    const list = [rec({ id: "a", category: "growth" }), rec({ id: "b", category: "launch" })];
    const matched = matchPlaybooks(list, { ideaId: "idea_1", category: "launch" });
    expect(matched[0]!.id).toBe("b");
  });

  it("excludes a playbook sourced ONLY from the target venture itself", () => {
    const own = rec({
      id: "own",
      provenance: [
        {
          sourceVentureHash: ventureHash("idea_1"),
          segment: "b2b",
          targetUser: "founders",
          outcome: "o",
          evidence: "e",
          verifierResultId: "vr",
        },
      ],
    });
    const other = rec({ id: "other" });
    const matched = matchPlaybooks([own, other], { ideaId: "idea_1" });
    expect(matched.map((m) => m.id)).toEqual(["other"]);
  });

  it("ranks same-audience playbooks above off-segment playbooks within a category", () => {
    const olderSameSegment = rec({
      id: "same",
      category: "launch",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      provenance: [
        {
          sourceVentureHash: ventureHash("idea_b2b"),
          segment: "b2b",
          targetUser: "mid-market revops teams",
          outcome: "o",
          evidence: "e",
          verifierResultId: "vr_same",
        },
      ],
    });
    const newerOffSegment = rec({
      id: "off",
      category: "launch",
      createdAt: new Date("2026-06-01T00:00:00Z"),
      provenance: [
        {
          sourceVentureHash: ventureHash("idea_b2c"),
          segment: "b2c",
          targetUser: "shopify founders",
          outcome: "o",
          evidence: "e",
          verifierResultId: "vr_off",
        },
      ],
    });

    const matched = matchPlaybooks([newerOffSegment, olderSameSegment], {
      ideaId: "idea_target",
      category: "launch",
      segment: "B2B",
      targetUser: "Mid-market RevOps teams",
    });

    expect(matched.map((m) => m.id)).toEqual(["same", "off"]);
  });
});
