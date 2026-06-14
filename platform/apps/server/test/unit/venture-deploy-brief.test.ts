import { describe, it, expect } from "vitest";
import { summarizeReleasesForBrief } from "../../src/venture-deploy/brief.js";
import type { ReleaseReceipt } from "../../src/venture-deploy/types.js";

function receipt(over: Partial<ReleaseReceipt>): ReleaseReceipt {
  return {
    id: "r",
    workspaceId: "ws1",
    ventureId: "v1",
    targetId: "t1",
    releaseRef: "sha",
    status: "promoted",
    action: "promote",
    reversibility: "cheap",
    requiresApproval: false,
    approvalRequestId: null,
    smokeCriticalCount: 0,
    url: null,
    incidentFiled: false,
    detail: "",
    createdAt: new Date(0),
    ...over,
  };
}

describe("summarizeReleasesForBrief (#195 AC4)", () => {
  it("rolls up promotes / rollbacks / owner-needed / incidents", () => {
    const view = summarizeReleasesForBrief([
      receipt({ status: "promoted" }),
      receipt({ status: "promoted" }),
      receipt({ status: "rolled_back", incidentFiled: true }),
      receipt({ status: "escalated", incidentFiled: true }),
      receipt({ status: "smoke_failed", incidentFiled: true }),
      receipt({ status: "deploy_failed" }),
    ]);
    expect(view).toEqual({ total: 6, promoted: 2, rolledBack: 1, needsOwner: 3, incidents: 3 });
  });

  it("is empty for no releases", () => {
    expect(summarizeReleasesForBrief([])).toEqual({
      total: 0,
      promoted: 0,
      rolledBack: 0,
      needsOwner: 0,
      incidents: 0,
    });
  });
});
