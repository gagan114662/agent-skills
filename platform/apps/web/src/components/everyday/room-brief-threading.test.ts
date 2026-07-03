import { describe, it, expect } from "vitest";
import { structuredRoomTask, ROOM_AGENT_TASKS } from "./LiveEverydayShell.js";

/**
 * GAP-1 (path A regression guard): the `/everyday` composer builds each agent's task via
 * `structuredRoomTask(spec, goal)`. This must keep threading the OWNER'S typed goal into every lane —
 * proving the composer path never regresses to a generic "market ipop" default (the symptom path C hit).
 */
describe("everyday composer room task threading (GAP-1 path A)", () => {
  const goal = "market a yoga studio in Brooklyn";

  it("threads the owner's goal into every agent's task, never a generic ipop default", () => {
    for (const spec of ROOM_AGENT_TASKS) {
      const task = structuredRoomTask(spec, goal);
      expect(task).toContain(goal);
      expect(task.toLowerCase()).not.toContain("launch ipop");
      expect(task.toLowerCase()).not.toContain("messaging-first");
    }
  });

  it("threads the goal into the immediate-request section, not just the header", () => {
    // A distinct, per-role instruction line ("7. Immediate task description or request") must also carry
    // the goal — otherwise an agent could read the header goal but act on a generic canned request.
    const scout = ROOM_AGENT_TASKS.find((spec) => spec.role === "Scout")!;
    expect(scout.immediateRequest(goal)).toContain(goal);
  });
});
