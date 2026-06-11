import { describe, it, expect } from "vitest";
import { draftSpec } from "../../src/planning/spec.js";
import { rankBacklog } from "../../src/planning/rice.js";
import type { BacklogItemRecord } from "../../src/planning/types.js";

function item(over: Partial<BacklogItemRecord> = {}): BacklogItemRecord {
  return {
    id: "item-1",
    workspaceId: "w1",
    ideaId: "idea-9",
    title: "Add CSV export to the dashboard",
    description: "Users keep asking to pull their data out into a spreadsheet.",
    source: "customer_voice",
    sourceRef: "insight:42",
    reach: 120,
    impact: 3,
    confidencePct: 80,
    effort: 3,
    isPivot: false,
    status: "proposed",
    targetChannelId: null,
    targetAgentMemberId: null,
    specId: null,
    approvalRequestId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...over,
  };
}

describe("draftSpec: a backlog item → a repo-lifecycle-format spec", () => {
  const ranked = rankBacklog([item()])[0];
  const spec = draftSpec(item(), ranked);

  it("titles the spec from the item title", () => {
    expect(spec.title).toBe("Spec: Add CSV export to the dashboard");
  });

  it("emits the repo lifecycle sections (Objective / Why ranked here / Acceptance / Non-goals)", () => {
    expect(spec.body).toContain("## Objective");
    expect(spec.body).toContain("## Why ranked here");
    expect(spec.body).toContain("## Acceptance");
    expect(spec.body).toContain("## Non-goals");
  });

  it("embeds the why-ranked-here evidence link (source + source_ref) and rank position", () => {
    expect(spec.body).toContain("customer_voice");
    expect(spec.body).toContain("insight:42");
    expect(spec.body).toContain("#1"); // its rank position in the backlog
  });

  it("shows the RICE breakdown that earned the rank (score + the four factors)", () => {
    // reach 120 × impact-tier-3 (×2) × confidence 0.8 / effort 3 = 64
    expect(spec.body).toContain("64");
    expect(spec.body).toContain("Reach");
    expect(spec.body).toContain("Impact");
    expect(spec.body).toContain("Confidence");
    expect(spec.body).toContain("Effort");
  });

  it("carries the item description into the objective", () => {
    expect(spec.body).toContain("Users keep asking to pull their data out");
  });

  it("flags a pivot in the body so the human reviewer sees it", () => {
    const pivotSpec = draftSpec(item({ isPivot: true }), ranked);
    expect(pivotSpec.body.toLowerCase()).toContain("pivot");
  });
});
