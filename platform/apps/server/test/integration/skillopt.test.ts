import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces, approvalRequests } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { createWorkspace } from "../../src/db/repositories/workspaces.js";
import { createHumanMember } from "../../src/db/repositories/members.js";
import {
  recordSkillOptRun,
  alreadyProposed,
  listSkillOptProposals,
  latestImprovementSignal,
  type SkillOptOutcomeRecord,
} from "../../src/db/repositories/skillopt-runs.js";
import { SkillOptService, type SkillOptDeps } from "../../src/skillopt/service.js";
import { SKILLOPT_DEFAULTS } from "../../src/skillopt/caps.js";
import { createRequest } from "../../src/db/repositories/approvals.js";
import { SKILLOPT_ADOPT_EDIT_ACTION } from "../../src/approvals/policy.js";
import type { ClusterCandidate } from "../../src/skillopt/cycle.js";
import type { TranscriptSample, ValidationReading } from "../../src/skillopt/contract.js";

/**
 * SkillOpt-Sleep run persistence (#283, ADR-0283) — integration tests against real Postgres. Cover the
 * durable ledger directly (record → read-back → dedup → before/after signal) and the full wired service
 * cycle end-to-end (harvest → mine → gate → stage a #13 request → persist; a re-run dedups, no duplicate).
 * Repository style (mirrors data-model.test.ts): each test gets a fresh workspace; cleanup cascades in
 * afterAll. Nothing here adopts an edit or moves money — proposals stay PENDING in the #13 queue.
 */

const created: string[] = [];

async function freshWorkspace() {
  const ws = await createWorkspace({ slug: `skillopt-${newId()}`, name: "SkillOpt Test WS" });
  created.push(ws.id);
  return ws;
}

afterAll(async () => {
  for (const id of created) {
    await db.delete(workspaces).where(eq(workspaces.id, id)); // cascades to runs/proposals/requests/members
  }
  await closeDb();
});

const stagedOutcome = (over: Partial<SkillOptOutcomeRecord> = {}): SkillOptOutcomeRecord => ({
  agentHandle: "scout",
  skillId: "scout/runbook",
  status: "staged",
  skipReason: null,
  clusterKey: "audit the homepage for seo",
  metric: "seo.click_through",
  higherIsBetter: true,
  baseline: 100,
  candidate: 130,
  improvementRatio: 0.3,
  sampleSize: 10,
  externallyVerified: true,
  currentDocSha: "sha-doc-1",
  requestId: null,
  ...over,
});

const skippedOutcome: SkillOptOutcomeRecord = {
  agentHandle: "echo",
  skillId: "echo/runbook",
  status: "skipped",
  skipReason: "no recurring tasks in the harvested transcripts",
  clusterKey: null,
  metric: null,
  higherIsBetter: null,
  baseline: null,
  candidate: null,
  improvementRatio: null,
  sampleSize: null,
  externallyVerified: null,
  currentDocSha: null,
  requestId: null,
};

describe("skillopt-runs repository (real Postgres)", () => {
  it("records a run + per-agent outcomes and reads back the BEFORE/AFTER signal", async () => {
    const ws = await freshWorkspace();
    const { runId } = await recordSkillOptRun({
      workspaceId: ws.id,
      enabled: true,
      outcomes: [stagedOutcome(), skippedOutcome],
    });
    expect(runId).toBeTruthy();

    const rows = await listSkillOptProposals(ws.id);
    expect(rows).toHaveLength(2);

    const staged = rows.find((r) => r.status === "staged")!;
    expect(staged.agentHandle).toBe("scout");
    expect(staged.baseline).toBe(100);
    expect(staged.candidate).toBe(130);
    expect(staged.improvementRatio).toBeCloseTo(0.3, 5);
    expect(staged.externallyVerified).toBe(true);
    expect(staged.runId).toBe(runId);

    const skipped = rows.find((r) => r.status === "skipped")!;
    expect(skipped.skipReason).toContain("no recurring");
    expect(skipped.baseline).toBeNull();
  });

  it("stores a non-finite improvement ratio (zero baseline) as null but keeps baseline/candidate", async () => {
    const ws = await freshWorkspace();
    await recordSkillOptRun({
      workspaceId: ws.id,
      enabled: true,
      outcomes: [
        stagedOutcome({ baseline: 0, candidate: 5, improvementRatio: Number.POSITIVE_INFINITY }),
      ],
    });
    const [row] = await listSkillOptProposals(ws.id);
    expect(row!.baseline).toBe(0);
    expect(row!.candidate).toBe(5);
    expect(row!.improvementRatio).toBeNull(); // ±Infinity normalized to null
  });

  it("alreadyProposed: true for the staged (handle, cluster, doc sha), false for a different doc sha", async () => {
    const ws = await freshWorkspace();
    await recordSkillOptRun({ workspaceId: ws.id, enabled: true, outcomes: [stagedOutcome()] });

    expect(await alreadyProposed(ws.id, "scout", "audit the homepage for seo", "sha-doc-1")).toBe(true);
    // A changed doc (e.g. after the owner adopts) ⇒ a fresh proposal is allowed.
    expect(await alreadyProposed(ws.id, "scout", "audit the homepage for seo", "sha-doc-2")).toBe(false);
    // A different cluster ⇒ not a duplicate.
    expect(await alreadyProposed(ws.id, "scout", "some other task", "sha-doc-1")).toBe(false);
    // Tenant isolation: another workspace never sees this proposal.
    const other = await freshWorkspace();
    expect(await alreadyProposed(other.id, "scout", "audit the homepage for seo", "sha-doc-1")).toBe(false);
  });

  it("a DEDUPED outcome does not count as already-proposed (only 'staged' does)", async () => {
    const ws = await freshWorkspace();
    await recordSkillOptRun({
      workspaceId: ws.id,
      enabled: true,
      outcomes: [stagedOutcome({ status: "deduped", clusterKey: "deduped task", requestId: null })],
    });
    expect(await alreadyProposed(ws.id, "scout", "deduped task", "sha-doc-1")).toBe(false);
  });

  it("latestImprovementSignal returns the most recent staged reading for the agent", async () => {
    const ws = await freshWorkspace();
    await recordSkillOptRun({
      workspaceId: ws.id,
      enabled: true,
      outcomes: [stagedOutcome({ candidate: 120, improvementRatio: 0.2, currentDocSha: "sha-a" })],
    });
    await recordSkillOptRun({
      workspaceId: ws.id,
      enabled: true,
      outcomes: [stagedOutcome({ candidate: 150, improvementRatio: 0.5, currentDocSha: "sha-b" })],
    });
    const sig = await latestImprovementSignal(ws.id, "scout");
    expect(sig).not.toBeNull();
    expect(sig!.candidate).toBe(150);
    expect(sig!.improvementRatio).toBeCloseTo(0.5, 5);
    expect(await latestImprovementSignal(ws.id, "nobody")).toBeNull();
  });
});

describe("SkillOptService.runWorkspace — full wired cycle (real Postgres)", () => {
  const reading: ValidationReading = {
    metric: "seo.click_through",
    higherIsBetter: true,
    baseline: 100,
    candidate: 130,
    sampleSize: 10,
    externallyVerified: true,
  };
  const candidate: ClusterCandidate = {
    clusterKey: "audit the homepage for seo",
    validation: reading,
    proposedAppendText: "## Homepage audit shortcut\nStart from the title tag.",
  };
  function samples(workspaceId: string): TranscriptSample[] {
    return Array.from({ length: 3 }, (_, i) => ({
      sampleId: `${i}`,
      workspaceId,
      agentHandle: "scout",
      taskText: "Audit the homepage for SEO",
      succeeded: true,
    }));
  }

  /** Wire the service with the REAL persistence + dedup + #13-staging seams against this workspace. */
  function wiredService(workspaceId: string): SkillOptService {
    const deps: SkillOptDeps = {
      caps: () => ({ ...SKILLOPT_DEFAULTS, enabled: true, ownerWorkspaceId: workspaceId }),
      agents: () => [{ handle: "scout", skillId: "scout/runbook" }],
      harvest: () => Promise.resolve(samples(workspaceId)),
      replay: () => Promise.resolve([candidate]),
      loadSkillDoc: () => Promise.resolve({ sha: "sha-doc-1", text: "# runbook" }),
      alreadyStaged: (input) =>
        alreadyProposed(input.workspaceId, input.agentHandle, input.clusterKey, input.currentDocSha),
      recordRun: (input) => recordSkillOptRun(input),
      stage: async (input) => {
        const req = await createRequest({
          workspaceId: input.workspaceId,
          requesterMemberId: input.requesterMemberId,
          actionType: SKILLOPT_ADOPT_EDIT_ACTION,
          payload: {
            handle: input.proposal.agentHandle,
            skillId: input.proposal.skillId,
            clusterKey: input.proposal.clusterKey,
          },
          amount: null,
          summary: `Adopt @${input.proposal.agentHandle} skill edit`,
          status: "pending",
          expiresAt: null,
          events: [{ type: "requested", detail: { source: "skillopt" } }],
        });
        return { id: req.id };
      },
    };
    return new SkillOptService(deps);
  }

  it("stages a PENDING #13 request, persists the run, then DEDUPS a re-run (no duplicate request)", async () => {
    const ws = await freshWorkspace();
    const owner = await createHumanMember({
      workspaceId: ws.id,
      email: `owner-${newId()}@example.com`,
      displayName: "Owner",
    });
    const svc = wiredService(ws.id);

    // First run: harvest → mine → gate → stage one #13 request, persist the run + signal.
    const first = await svc.runWorkspace({ workspaceId: ws.id, requesterMemberId: owner.id });
    expect(first.enabled).toBe(true);
    expect(first.runId).toBeTruthy();
    expect(first.agents[0]!.result.status).toBe("staged");
    expect(first.agents[0]!.deduped).toBe(false);
    expect(first.agents[0]!.requestId).toBeTruthy();

    // Exactly one PENDING #13 adopt-edit request exists.
    const afterFirst = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.workspaceId, ws.id));
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.actionType).toBe(SKILLOPT_ADOPT_EDIT_ACTION);
    expect(afterFirst[0]!.status).toBe("pending"); // never auto-adopted

    // The before/after signal is queryable.
    const sig = await latestImprovementSignal(ws.id, "scout");
    expect(sig!.candidate).toBe(130);
    expect(sig!.requestId).toBe(first.agents[0]!.requestId);

    // Second run against the SAME unchanged doc: the guard suppresses a duplicate request.
    const second = await svc.runWorkspace({ workspaceId: ws.id, requesterMemberId: owner.id });
    expect(second.agents[0]!.result.status).toBe("staged"); // the pure decision is unchanged
    expect(second.agents[0]!.deduped).toBe(true); // but it was deduped
    expect(second.agents[0]!.requestId).toBeNull();

    const afterSecond = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.workspaceId, ws.id));
    expect(afterSecond).toHaveLength(1); // still exactly one — no duplicate

    // Two runs persisted; the second's outcome is recorded as 'deduped'.
    const proposals = await listSkillOptProposals(ws.id);
    expect(proposals).toHaveLength(2);
    expect(proposals.filter((p) => p.status === "staged")).toHaveLength(1);
    expect(proposals.filter((p) => p.status === "deduped")).toHaveLength(1);
  });
});
