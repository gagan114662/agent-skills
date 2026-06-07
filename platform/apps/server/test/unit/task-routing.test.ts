import { describe, it, expect } from "vitest";
import { selectLeastLoaded } from "../../src/tasks/routing.js";

describe("auto-routing selection (#14)", () => {
  it("returns null when no agent is eligible", () => {
    expect(selectLeastLoaded([])).toBeNull();
  });

  it("picks the single eligible agent", () => {
    expect(selectLeastLoaded([{ memberId: "a", openTasks: 7 }])).toBe("a");
  });

  it("round-robins by load: picks the least-loaded eligible agent", () => {
    const chosen = selectLeastLoaded([
      { memberId: "busy", openTasks: 5 },
      { memberId: "free", openTasks: 1 },
      { memberId: "mid", openTasks: 3 },
    ]);
    expect(chosen).toBe("free");
  });

  it("breaks ties deterministically by member id (ascending)", () => {
    const chosen = selectLeastLoaded([
      { memberId: "zeta", openTasks: 2 },
      { memberId: "alpha", openTasks: 2 },
    ]);
    expect(chosen).toBe("alpha");
  });
});
