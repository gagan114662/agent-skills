import { describe, it, expect } from "vitest";
import { ventureWeeklyPlanExecutor } from "../../src/venture-memory/executor.js";

describe("ventureWeeklyPlanExecutor: payload validation + summary (pure surface)", () => {
  it("requires a non-empty planId", () => {
    expect(ventureWeeklyPlanExecutor.validate({ planId: "p_1" })).toEqual({ ok: true });
    expect(ventureWeeklyPlanExecutor.validate({ planId: "" }).ok).toBe(false);
    expect(ventureWeeklyPlanExecutor.validate({}).ok).toBe(false);
    expect(ventureWeeklyPlanExecutor.validate("nope").ok).toBe(false);
    expect(ventureWeeklyPlanExecutor.validate(null).ok).toBe(false);
  });

  it("summarizes the dispatch action for the owner queue", () => {
    const s = ventureWeeklyPlanExecutor.summarize({ planId: "p_1", ideaId: "idea_1" });
    expect(s).toContain("p_1");
    expect(s).toContain("idea_1");
  });

  it("is registered under the sensitive-by-default action type", () => {
    expect(ventureWeeklyPlanExecutor.actionType).toBe("venture.weekly_plan");
  });
});
