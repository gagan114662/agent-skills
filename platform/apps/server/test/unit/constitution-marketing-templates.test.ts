import { describe, it, expect } from "vitest";
import {
  UNSCALABLE_OPS_TEMPLATES,
  unscalableOpsTemplates,
  marketingAgentSpecs,
} from "../../src/marketing/blueprint.js";

describe("Article IV — unscalable-ops fleet task templates (#146)", () => {
  it("provides manual-first, founder-led acquisition templates", () => {
    expect(UNSCALABLE_OPS_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    expect(unscalableOpsTemplates()).toBe(UNSCALABLE_OPS_TEMPLATES);
    const keys = UNSCALABLE_OPS_TEMPLATES.map((t) => t.key);
    expect(keys).toContain("collison_install"); // the Collison install is the canonical example
  });

  it("every template is a one-to-one, manual brief (not a scalable blast)", () => {
    for (const t of UNSCALABLE_OPS_TEMPLATES) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.brief.length).toBeGreaterThan(0);
      expect(t.brief.toLowerCase()).toMatch(/personal|one-to-one|hand|concierge|each/);
    }
  });

  it("every template keeps external sends approval-gated (draft-only contract)", () => {
    for (const t of UNSCALABLE_OPS_TEMPLATES) {
      expect(t.brief.toLowerCase()).toContain("draft");
      expect(t.brief.toLowerCase()).toMatch(/approve|approval/);
    }
  });

  it("no marketing agent has any send/post/spend tool — sends only via #13", () => {
    const forbidden = /(send|post|email|spend|publish)/i;
    for (const spec of marketingAgentSpecs()) {
      for (const tool of spec.allowedTools) {
        expect(tool).not.toMatch(forbidden);
      }
    }
  });
});
