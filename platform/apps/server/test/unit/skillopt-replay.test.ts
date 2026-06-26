import { describe, expect, it } from "vitest";
import {
  buildReplayCandidatesFromVerifierReceipts,
  parseReplayClaimRef,
  type ReplayReceipt,
} from "../../src/skillopt/replay.js";
import type { TaskCluster } from "../../src/skillopt/contract.js";

const cluster: TaskCluster = {
  key: "audit customer landing page",
  representativeTask: "Audit customer landing page",
  count: 5,
  sampleIds: ["s1", "s2", "s3", "s4", "s5"],
};

const receipt = (over: Partial<ReplayReceipt> = {}): ReplayReceipt => ({
  kind: "growth_metric",
  claimRef: "skillopt:scout:" + encodeURIComponent(cluster.key) + ":seo.clicks",
  status: "passed",
  measuredValue: 12,
  threshold: 5,
  source: "analytics",
  createdAt: new Date("2026-06-25T12:00:00Z"),
  ...over,
});

describe("skillopt/replay", () => {
  it("turns a passed externally grounded verifier row into a validation candidate", () => {
    const [candidate] = buildReplayCandidatesFromVerifierReceipts({
      agentHandle: "scout",
      skillId: "scout/runbook",
      clusters: [cluster],
      receipts: [receipt()],
    });

    expect(candidate).toMatchObject({
      clusterKey: cluster.key,
      validation: {
        metric: "seo.clicks",
        higherIsBetter: true,
        baseline: 0,
        candidate: 12,
        sampleSize: 5,
        externallyVerified: true,
      },
    });
    expect(candidate!.proposedAppendText).toContain("externally verified seo.clicks receipt");
  });

  it("requires the receipt to be explicitly keyed to the same agent and cluster", () => {
    const candidates = buildReplayCandidatesFromVerifierReceipts({
      agentHandle: "scout",
      skillId: "scout/runbook",
      clusters: [cluster],
      receipts: [
        receipt({ claimRef: "skillopt:quill:" + encodeURIComponent(cluster.key) }),
        receipt({ claimRef: "some-other-verifier-claim" }),
      ],
    });

    expect(candidates).toEqual([]);
  });

  it("rejects unpassed, ungrounded, or non-improving verifier rows", () => {
    const candidates = buildReplayCandidatesFromVerifierReceipts({
      agentHandle: "scout",
      skillId: "scout/runbook",
      clusters: [cluster],
      receipts: [
        receipt({ status: "failed" }),
        receipt({ source: "manual" }),
        receipt({ measuredValue: 0 }),
        receipt({ kind: "fix_held", measuredValue: 1 }),
      ],
    });

    expect(candidates).toEqual([]);
  });

  it("treats settled revenue verifier rows as external receipts", () => {
    const [candidate] = buildReplayCandidatesFromVerifierReceipts({
      agentHandle: "scout",
      skillId: "scout/runbook",
      clusters: [cluster],
      receipts: [receipt({ kind: "revenue_real", source: "billing", measuredValue: 2 })],
    });

    expect(candidate!.validation.metric).toBe("seo.clicks");
    expect(candidate!.validation.candidate).toBe(2);
    expect(candidate!.validation.externallyVerified).toBe(true);
  });

  it("parses urlencoded SkillOpt claim refs", () => {
    expect(parseReplayClaimRef("skillopt:scout:audit%20customer%20landing%20page:seo.clicks")).toEqual({
      agentHandle: "scout",
      clusterKey: "audit customer landing page",
      metric: "seo.clicks",
    });
  });
});
