/**
 * Unit tests for the pure transition core (#598): stage ordering, approval-required stages, and the
 * gate-verdict → transition mapping.
 */

import { describe, it, expect } from "vitest";
import {
  nextStage,
  requiresApproval,
  stageIndex,
  transitionForGate,
  isExecutableStage,
} from "../../src/seo-content/pipeline.js";
import { PIPELINE_STAGES, type GateDecision } from "../../src/seo-content/types.js";

describe("pipeline transition core (#598)", () => {
  it("orders the stages keyword → brief → draft → publish → index_ping", () => {
    expect(PIPELINE_STAGES).toEqual(["keyword", "brief", "draft", "publish", "index_ping"]);
    expect(nextStage("keyword")).toBe("brief");
    expect(nextStage("brief")).toBe("draft");
    expect(nextStage("draft")).toBe("publish");
    expect(nextStage("publish")).toBe("index_ping");
    expect(nextStage("index_ping")).toBe("done"); // last executable stage advances to terminal
  });

  it("requires an approval only for the two side-effecting stages", () => {
    expect(requiresApproval("keyword")).toBe(false);
    expect(requiresApproval("brief")).toBe(false);
    expect(requiresApproval("draft")).toBe(false);
    expect(requiresApproval("publish")).toBe(true);
    expect(requiresApproval("index_ping")).toBe(true);
  });

  it("exposes a stable zero-based stage index", () => {
    expect(stageIndex("keyword")).toBe(0);
    expect(stageIndex("index_ping")).toBe(4);
  });

  it("maps an allow verdict to an advance and any block verdict to a block (fail-closed)", () => {
    const allow: GateDecision = { decision: "allow", reasons: [] };
    expect(transitionForGate("draft", allow)).toEqual({ kind: "advance", from: "draft", to: "publish" });

    const block: GateDecision = {
      decision: "block",
      reasons: [{ code: "draft_too_short", message: "too short" }],
    };
    expect(transitionForGate("draft", block)).toEqual({
      kind: "block",
      stage: "draft",
      reasons: block.reasons,
    });
  });

  it("treats only the terminal `done` stage as non-executable", () => {
    expect(isExecutableStage("keyword")).toBe(true);
    expect(isExecutableStage("index_ping")).toBe(true);
    expect(isExecutableStage("done")).toBe(false);
  });
});
