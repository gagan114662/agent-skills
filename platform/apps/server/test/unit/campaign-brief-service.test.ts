import { describe, it, expect, beforeEach } from "vitest";
import { CampaignBriefService } from "../../src/campaign-brief/service.js";
import { InMemoryBriefStore } from "../../src/campaign-brief/store.js";

/**
 * The campaign brief service (#588): get/update lifecycle, the agent-read seam, and the two invariants the
 * issue turns on — edits PROPAGATE to in-flight planning (the read is live), and a workspace can only ever
 * see its own brief (#3 IDOR). Deterministic via an injected clock + the in-memory store (no DB).
 */
const WID = "ws-1";
const OTHER = "ws-2";
const OWNER = "member-owner";
const CLOCK = () => new Date(1_700_000_000_000);

function makeService() {
  const store = new InMemoryBriefStore();
  const service = new CampaignBriefService({ store, now: CLOCK });
  return { store, service };
}

describe("CampaignBriefService (#588)", () => {
  let service: CampaignBriefService;
  beforeEach(() => {
    service = makeService().service;
  });

  it("an unwritten workspace reads the empty brief at revision 0", async () => {
    const rec = await service.get(WID);
    expect(rec.revision).toBe(0);
    expect(rec.updatedByMemberId).toBeNull();
    expect(rec.brief.positioning).toBe("");
    expect(rec.brief.goals).toEqual([]);
  });

  it("update sanitizes the patch, bumps the revision, and records the editor", async () => {
    const rec = await service.update(
      WID,
      { positioning: "AI marketing department", goals: ["Land 100 founders", "Land 100 founders"] },
      OWNER,
    );
    expect(rec.revision).toBe(1);
    expect(rec.updatedByMemberId).toBe(OWNER);
    expect(rec.updatedAt).toEqual(CLOCK());
    expect(rec.brief.positioning).toBe("AI marketing department");
    expect(rec.brief.goals).toEqual(["Land 100 founders"]); // deduped
  });

  it("a second edit replaces present fields, preserves absent ones, and bumps revision again", async () => {
    await service.update(WID, { icp: "founders", voice: "warm" }, OWNER);
    const rec = await service.update(WID, { voice: "bold" }, OWNER);
    expect(rec.revision).toBe(2);
    expect(rec.brief.icp).toBe("founders"); // preserved
    expect(rec.brief.voice).toBe("bold"); // replaced
  });

  it("briefingForTask returns a null preamble before any brief is set (task untouched)", async () => {
    const briefing = await service.briefingForTask(WID);
    expect(briefing.revision).toBe(0);
    expect(briefing.preamble).toBeNull();
    expect(briefing.citation).toBeNull();
  });

  it("an edit PROPAGATES to the next task an in-flight planner starts (acceptance)", async () => {
    // Planner reads the brief at the start of task A — nothing set yet.
    const before = await service.briefingForTask(WID);
    expect(before.preamble).toBeNull();

    // The owner edits the brief mid-flight.
    await service.update(WID, { positioning: "Ships real marketing work", brandClaims: ["Human-approved"] }, OWNER);

    // The SAME planner reads again at the start of task B — it sees the new revision + content. No restart,
    // no cache: the single-source read is what makes the change propagate.
    const after = await service.briefingForTask(WID);
    expect(after.revision).toBe(1);
    expect(after.preamble).not.toBeNull();
    expect(after.preamble as string).toContain("Ships real marketing work");
    expect(after.citation).toContain("rev 1");
  });

  it("enrichTask prepends the live briefing and keeps the task verbatim below a Task: label", async () => {
    await service.update(WID, { positioning: "Autonomous marketing" }, OWNER);
    const { task, revision } = await service.enrichTask(WID, "Write a launch tweet");
    expect(revision).toBe(1);
    expect(task).toContain("Autonomous marketing");
    expect(task).toContain("Task: Write a launch tweet");
    // The agent can always separate its instruction from the brief DATA.
    expect(task.indexOf("Campaign Brief")).toBeLessThan(task.indexOf("Task:"));
  });

  it("enrichTask returns the task unchanged when no brief is set", async () => {
    const { task, revision } = await service.enrichTask(WID, "Write a launch tweet");
    expect(task).toBe("Write a launch tweet");
    expect(revision).toBe(0);
  });

  it("is workspace-scoped — one workspace never sees another's brief (#3 IDOR)", async () => {
    await service.update(WID, { positioning: "ws-1 secret positioning" }, OWNER);
    const other = await service.get(OTHER);
    expect(other.revision).toBe(0);
    expect(other.brief.positioning).toBe("");
    const otherBriefing = await service.briefingForTask(OTHER);
    expect(otherBriefing.preamble).toBeNull();
  });
});
