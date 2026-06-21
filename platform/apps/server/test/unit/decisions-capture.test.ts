import { describe, it, expect } from "vitest";
import {
  captureDecisionsFromDeliverable,
  extractDecisionStatements,
} from "../../src/decisions/capture.js";
import { DecisionService } from "../../src/decisions/service.js";
import type { DecisionDeps } from "../../src/decisions/service.js";
import type { RecordDecisionRequest } from "../../src/decisions/types.js";

/**
 * Auto-capture (issue #513): a posted deliverable's decision statements become recorded decisions, so a
 * teammate reuses them without being re-told. Pure extraction + a thin recorder over a fake service.
 */

describe("extractDecisionStatements", () => {
  it("picks out decision-type sentences and ignores plain facts", async () => {
    const out = await extractDecisionStatements(
      "The API runs on port 3000. We decided to ship weekly. Let's go with monthly billing.",
    );
    expect(out).toContain("We decided to ship weekly");
    expect(out.some((s) => /monthly billing/.test(s))).toBe(true);
    expect(out.some((s) => /port 3000/.test(s))).toBe(false);
  });

  it("caps the number of captured statements", async () => {
    const text = "We decided A. We decided B. We decided C. We decided D.";
    expect((await extractDecisionStatements(text, 2)).length).toBe(2);
  });

  it("returns nothing when the deliverable states no decision", async () => {
    expect(await extractDecisionStatements("Here is a status update with no choices made.")).toEqual([]);
  });
});

describe("captureDecisionsFromDeliverable", () => {
  function fakeService(recorded: RecordDecisionRequest[]): DecisionService {
    const deps: Partial<DecisionDeps> = {
      mirrorToMemory: async () => "mem",
      record: async () => ({ id: "d", created: true }),
    };
    const svc = new DecisionService(deps as DecisionDeps);
    // intercept record() to capture the request the service composes
    const orig = svc.record.bind(svc);
    svc.record = async (req) => {
      recorded.push(req);
      return orig(req);
    };
    return svc;
  }

  it("records each decision against the task topic and returns the count", async () => {
    const recorded: RecordDecisionRequest[] = [];
    const n = await captureDecisionsFromDeliverable(fakeService(recorded), {
      workspaceId: "w1",
      agentMemberId: "m-a",
      task: "Q3 pricing page",
      deliverable: "We decided to lead with the annual plan. The hero stays as-is.",
    });
    expect(n).toBe(1);
    expect(recorded[0]).toMatchObject({ workspaceId: "w1", decidedByMemberId: "m-a", topic: "Q3 pricing page" });
    expect(recorded[0]!.title).toMatch(/annual plan/);
  });

  it("is a no-op (count 0) when there is no decision to capture", async () => {
    const recorded: RecordDecisionRequest[] = [];
    const n = await captureDecisionsFromDeliverable(fakeService(recorded), {
      workspaceId: "w1",
      agentMemberId: "m-a",
      task: "status",
      deliverable: "All systems nominal; nothing to report.",
    });
    expect(n).toBe(0);
    expect(recorded).toHaveLength(0);
  });
});
