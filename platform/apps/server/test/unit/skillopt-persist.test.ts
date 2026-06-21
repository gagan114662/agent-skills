import { describe, it, expect } from "vitest";
import { SkillOptService, type SkillOptDeps } from "../../src/skillopt/service.js";
import { SKILLOPT_DEFAULTS, type SkillOptCaps } from "../../src/skillopt/caps.js";
import type { ClusterCandidate } from "../../src/skillopt/cycle.js";
import type { TranscriptSample, ValidationReading } from "../../src/skillopt/contract.js";
import type { SkillOptOutcomeRecord } from "../../src/db/repositories/skillopt-runs.js";

// baseline 100 → candidate 130, higher-is-better ⇒ +30% measured improvement (the persisted signal).
const reading: ValidationReading = {
  metric: "seo.click_through",
  higherIsBetter: true,
  baseline: 100,
  candidate: 130,
  sampleSize: 10,
  externallyVerified: true,
};

function harvestSamples(): TranscriptSample[] {
  return Array.from({ length: 3 }, (_, i) => ({
    sampleId: String(i),
    workspaceId: "ws-owner",
    agentHandle: "scout",
    taskText: "Audit the homepage for SEO",
    succeeded: true,
  }));
}

const candidate: ClusterCandidate = {
  clusterKey: "audit the homepage for seo",
  validation: reading,
  proposedAppendText: "## Homepage audit shortcut\nStart from the title tag.",
};

interface Recorded {
  staged: { proposal: { clusterKey: string; currentDocSha: string } }[];
  recorded: { workspaceId: string; enabled: boolean; outcomes: SkillOptOutcomeRecord[] }[];
  dedupCalls: { agentHandle: string; clusterKey: string; currentDocSha: string }[];
}

function makeDeps(
  over: {
    caps?: SkillOptCaps;
    replay?: SkillOptDeps["replay"];
    alreadyStaged?: SkillOptDeps["alreadyStaged"];
  } = {},
): { deps: SkillOptDeps; rec: Recorded } {
  const rec: Recorded = { staged: [], recorded: [], dedupCalls: [] };
  const caps = over.caps ?? { ...SKILLOPT_DEFAULTS, enabled: true, ownerWorkspaceId: "ws-owner" };
  const deps: SkillOptDeps = {
    caps: () => caps,
    agents: () => [{ handle: "scout", skillId: "scout/runbook" }],
    harvest: () => Promise.resolve(harvestSamples()),
    replay: over.replay ?? (() => Promise.resolve([candidate])),
    loadSkillDoc: () => Promise.resolve({ sha: "sha-doc-1", text: "# runbook" }),
    stage: async (input) => {
      rec.staged.push({
        proposal: {
          clusterKey: input.proposal.clusterKey,
          currentDocSha: input.proposal.currentDocSha,
        },
      });
      return { id: `req-${rec.staged.length}` };
    },
    alreadyStaged:
      over.alreadyStaged ??
      ((input) => {
        rec.dedupCalls.push({
          agentHandle: input.agentHandle,
          clusterKey: input.clusterKey,
          currentDocSha: input.currentDocSha,
        });
        return Promise.resolve(false);
      }),
    recordRun: async (input) => {
      rec.recorded.push(input);
      return { runId: `run-${rec.recorded.length}` };
    },
  };
  return { deps, rec };
}

describe("skillopt/service — #283 persistence (recordRun)", () => {
  it("records the run + a staged outcome carrying the BEFORE/AFTER signal, and propagates the run id", async () => {
    const { deps, rec } = makeDeps();
    const res = await new SkillOptService(deps).runWorkspace({
      workspaceId: "ws-owner",
      requesterMemberId: "owner",
    });

    expect(res.runId).toBe("run-1");
    expect(rec.recorded).toHaveLength(1);
    expect(rec.recorded[0]!.enabled).toBe(true);

    const outcome = rec.recorded[0]!.outcomes[0]!;
    expect(outcome.status).toBe("staged");
    expect(outcome.agentHandle).toBe("scout");
    expect(outcome.skillId).toBe("scout/runbook");
    // The measurable before/after signal is persisted.
    expect(outcome.baseline).toBe(100);
    expect(outcome.candidate).toBe(130);
    expect(outcome.improvementRatio).toBeCloseTo(0.3, 5);
    expect(outcome.externallyVerified).toBe(true);
    expect(outcome.sampleSize).toBe(10);
    expect(outcome.currentDocSha).toBe("sha-doc-1");
    expect(outcome.requestId).toBe("req-1");
  });

  it("records a SKIPPED outcome (with reason, null signal) when the replay seam yields no candidate", async () => {
    const { deps, rec } = makeDeps({ replay: () => Promise.resolve([]) });
    const res = await new SkillOptService(deps).runWorkspace({
      workspaceId: "ws-owner",
      requesterMemberId: "owner",
    });
    expect(res.agents[0]!.result.status).toBe("skipped");
    const outcome = rec.recorded[0]!.outcomes[0]!;
    expect(outcome.status).toBe("skipped");
    expect(outcome.skipReason).toBeTruthy();
    expect(outcome.baseline).toBeNull();
    expect(outcome.improvementRatio).toBeNull();
    expect(outcome.requestId).toBeNull();
    expect(rec.staged).toHaveLength(0);
  });

  it("does NOT record when the loop is disabled (early return, runId null)", async () => {
    const { deps, rec } = makeDeps({ caps: { ...SKILLOPT_DEFAULTS, enabled: false } });
    const res = await new SkillOptService(deps).runWorkspace({
      workspaceId: "ws-owner",
      requesterMemberId: "owner",
    });
    expect(res.enabled).toBe(false);
    expect(res.runId).toBeNull();
    expect(rec.recorded).toHaveLength(0);
  });
});

describe("skillopt/service — #283 idempotency (alreadyStaged dedup)", () => {
  it("checks the guard with the cluster key + doc sha the proposal pins", async () => {
    const { deps, rec } = makeDeps();
    await new SkillOptService(deps).runWorkspace({ workspaceId: "ws-owner", requesterMemberId: "owner" });
    expect(rec.dedupCalls).toEqual([
      { agentHandle: "scout", clusterKey: "audit the homepage for seo", currentDocSha: "sha-doc-1" },
    ]);
  });

  it("SUPPRESSES a duplicate #13 request when the edit was already proposed against this doc", async () => {
    const { deps, rec } = makeDeps({ alreadyStaged: () => Promise.resolve(true) });
    const res = await new SkillOptService(deps).runWorkspace({
      workspaceId: "ws-owner",
      requesterMemberId: "owner",
    });
    // The pure decision is still "staged", but no request was created and the outcome is marked deduped.
    expect(res.agents[0]!.result.status).toBe("staged");
    expect(res.agents[0]!.deduped).toBe(true);
    expect(res.agents[0]!.requestId).toBeNull();
    expect(rec.staged).toHaveLength(0);
    // The before/after signal is still persisted, under the 'deduped' status.
    const outcome = rec.recorded[0]!.outcomes[0]!;
    expect(outcome.status).toBe("deduped");
    expect(outcome.candidate).toBe(130);
    expect(outcome.requestId).toBeNull();
  });

  it("stages normally (no dedup) when the guard reports the edit is new", async () => {
    const { deps, rec } = makeDeps({ alreadyStaged: () => Promise.resolve(false) });
    const res = await new SkillOptService(deps).runWorkspace({
      workspaceId: "ws-owner",
      requesterMemberId: "owner",
    });
    expect(res.agents[0]!.deduped).toBe(false);
    expect(res.agents[0]!.requestId).toBe("req-1");
    expect(rec.staged).toHaveLength(1);
  });
});
