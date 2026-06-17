import { describe, it, expect } from "vitest";
import { SkillOptService, type SkillOptDeps } from "../../src/skillopt/service.js";
import { SKILLOPT_DEFAULTS, type SkillOptCaps } from "../../src/skillopt/caps.js";
import type { ClusterCandidate } from "../../src/skillopt/cycle.js";
import type { TranscriptSample, ValidationReading } from "../../src/skillopt/contract.js";

const reading: ValidationReading = {
  metric: "seo.click_through",
  higherIsBetter: true,
  baseline: 100,
  candidate: 130,
  sampleSize: 10,
  externallyVerified: true,
};

function harvestSamples(): TranscriptSample[] {
  return [
    { sampleId: "1", workspaceId: "ws-owner", agentHandle: "scout", taskText: "Audit the homepage for SEO", succeeded: true },
    { sampleId: "2", workspaceId: "ws-owner", agentHandle: "scout", taskText: "Audit the homepage for SEO", succeeded: true },
    { sampleId: "3", workspaceId: "ws-owner", agentHandle: "scout", taskText: "Audit the homepage for SEO", succeeded: true },
  ];
}

function makeDeps(over: Omit<Partial<SkillOptDeps>, "caps"> & { caps?: SkillOptCaps } = {}): {
  deps: SkillOptDeps;
  staged: { workspaceId: string; proposal: { appendText: string } }[];
} {
  const staged: { workspaceId: string; proposal: { appendText: string } }[] = [];
  const caps = over.caps ?? { ...SKILLOPT_DEFAULTS, enabled: true, ownerWorkspaceId: "ws-owner" };
  const candidate: ClusterCandidate = {
    clusterKey: "audit the homepage for seo",
    validation: reading,
    proposedAppendText: "## Homepage audit shortcut\nStart from the title tag.",
  };
  const deps: SkillOptDeps = {
    caps: () => caps,
    agents: over.agents ?? (() => [{ handle: "scout", skillId: "scout/runbook" }]),
    harvest: over.harvest ?? (() => Promise.resolve(harvestSamples())),
    replay: over.replay ?? (() => Promise.resolve([candidate])),
    loadSkillDoc: over.loadSkillDoc ?? (() => Promise.resolve({ sha: "sha-1", text: "# runbook" })),
    stage:
      over.stage ??
      (async (input) => {
        staged.push({ workspaceId: input.workspaceId, proposal: input.proposal });
        return { id: `req-${staged.length}` };
      }),
  };
  return { deps, staged };
}

describe("skillopt/service — SkillOptService.runWorkspace", () => {
  it("does NOTHING when the loop is disabled for the workspace (default OFF)", async () => {
    const { deps, staged } = makeDeps({ caps: { ...SKILLOPT_DEFAULTS, enabled: false } });
    const res = await new SkillOptService(deps).runWorkspace({
      workspaceId: "ws-owner",
      requesterMemberId: "owner",
    });
    expect(res.enabled).toBe(false);
    expect(res.agents).toEqual([]);
    expect(staged).toHaveLength(0);
  });

  it("does NOTHING for a non-owner workspace when owner-first (the dogfood scope)", async () => {
    const { deps, staged } = makeDeps();
    const res = await new SkillOptService(deps).runWorkspace({
      workspaceId: "ws-other",
      requesterMemberId: "owner",
    });
    expect(res.enabled).toBe(false);
    expect(staged).toHaveLength(0);
  });

  it("STAGES a #13 proposal on the happy path for the owner workspace", async () => {
    const { deps, staged } = makeDeps();
    const res = await new SkillOptService(deps).runWorkspace({
      workspaceId: "ws-owner",
      requesterMemberId: "owner",
    });
    expect(res.enabled).toBe(true);
    expect(res.agents).toHaveLength(1);
    expect(res.agents[0]!.result.status).toBe("staged");
    expect(res.agents[0]!.requestId).toBe("req-1");
    expect(staged).toHaveLength(1);
    expect(staged[0]!.proposal.appendText).toContain("Homepage audit shortcut");
  });

  it("stages NOTHING when the replay seam yields no candidates (the safe production default)", async () => {
    const { deps, staged } = makeDeps({ replay: () => Promise.resolve([]) });
    const res = await new SkillOptService(deps).runWorkspace({
      workspaceId: "ws-owner",
      requesterMemberId: "owner",
    });
    expect(res.enabled).toBe(true);
    expect(res.agents[0]!.result.status).toBe("skipped");
    expect(res.agents[0]!.requestId).toBeNull();
    expect(staged).toHaveLength(0);
  });

  it("stages NOTHING when the gate rejects an unverified reading", async () => {
    const candidate: ClusterCandidate = {
      clusterKey: "audit the homepage for seo",
      validation: { ...reading, externallyVerified: false },
      proposedAppendText: "## shortcut\nbody",
    };
    const { deps, staged } = makeDeps({ replay: () => Promise.resolve([candidate]) });
    const res = await new SkillOptService(deps).runWorkspace({
      workspaceId: "ws-owner",
      requesterMemberId: "owner",
    });
    expect(res.agents[0]!.result.status).toBe("skipped");
    expect(staged).toHaveLength(0);
  });
});
