import { describe, it, expect } from "vitest";
import { TurnController, type TurnControllerDeps, type TurnGit } from "../../src/turns/controller.js";
import type { PlanProposal } from "../../src/db/repositories/plan-proposals.js";
import type { SessionTurn } from "../../src/db/repositories/session-turns.js";
import { PLAN_MARKER_START, PLAN_MARKER_END } from "../../src/turns/plan.js";

/**
 * TurnController (#53) on fakes — no DB, no git, no model. Proves plan mode blocks until a decision,
 * approve(-with-feedback) launches the execution with the plan/feedback composed in, reject launches
 * nothing, checkpoints record the ledger, and revert wires git reset + message soft-delete.
 */

// --- fakes ------------------------------------------------------------------

interface LaunchCall {
  task: string;
  harnessEnv?: Record<string, string>;
  agentMemberId: string;
  createdByMemberId: string;
}

class FakeGit implements TurnGit {
  readonly resets: Array<{ key: string; sha: string }> = [];
  head = "base000";
  commitShas: string[] = [];
  currentHeadSha(): Promise<string> {
    return Promise.resolve(this.head);
  }
  commitTurn(): Promise<string | null> {
    return Promise.resolve(this.commitShas.shift() ?? "sha_work");
  }
  resetTo(key: string, sha: string): Promise<void> {
    this.resets.push({ key, sha });
    return Promise.resolve();
  }
}

function makeDeps(over: { git?: TurnGit | null; planOutput?: string } = {}) {
  const launches: LaunchCall[] = [];
  const proposals: PlanProposal[] = [];
  const turns: SessionTurn[] = [];
  const reverted: string[] = [];
  const softDeleted: Array<{ channelId: string; after: string | null }> = [];
  let seq = 0;

  const deps: TurnControllerDeps = {
    launcher: {
      launch(input) {
        launches.push({
          task: input.task,
          harnessEnv: input.harnessEnv,
          agentMemberId: input.agentMemberId,
          createdByMemberId: input.createdByMemberId,
        });
        return Promise.resolve({ id: `sess_${++seq}` });
      },
      join: () => Promise.resolve(),
    },
    sessionResult: () =>
      Promise.resolve(
        over.planOutput ?? `${PLAN_MARKER_START}\n1. read\n2. change\n${PLAN_MARKER_END}`,
      ),
    git: over.git === undefined ? new FakeGit() : over.git,
    createProposal(input) {
      const p: PlanProposal = {
        id: `prop_${proposals.length + 1}`,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        agentMemberId: input.agentMemberId,
        planSessionId: input.planSessionId,
        originalTask: input.originalTask,
        planText: input.planText,
        status: "proposed",
        feedback: null,
        executionSessionId: null,
        createdByMemberId: input.createdByMemberId,
        decidedByMemberId: null,
        createdAt: new Date(0),
        decidedAt: null,
      };
      proposals.push(p);
      return Promise.resolve(p);
    },
    getProposal: (id, channelId) =>
      Promise.resolve(proposals.find((p) => p.id === id && p.channelId === channelId)),
    decideProposal(id, fields) {
      const p = proposals.find((x) => x.id === id)!;
      p.status = fields.status;
      p.feedback = fields.feedback;
      p.decidedByMemberId = fields.decidedByMemberId;
      p.executionSessionId = fields.executionSessionId ?? null;
      return Promise.resolve();
    },
    nextTurnIdx: (sessionId) =>
      Promise.resolve(turns.filter((t) => t.sessionId === sessionId).length),
    createTurn(input) {
      const t: SessionTurn = {
        id: `turn_${turns.length + 1}`,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        sessionId: input.sessionId,
        idx: input.idx,
        kind: input.kind,
        headSha: input.headSha,
        cursorMessageId: input.cursorMessageId,
        planProposalId: input.planProposalId ?? null,
        createdByMemberId: input.createdByMemberId ?? null,
        revertedAt: null,
        createdAt: new Date(0),
      };
      turns.push(t);
      return Promise.resolve(t);
    },
    listTurns: (sessionId, opts) =>
      Promise.resolve(
        turns.filter(
          (t) => t.sessionId === sessionId && (!opts?.liveOnly || t.revertedAt === null),
        ),
      ),
    markTurnsReverted(ids) {
      reverted.push(...ids);
      for (const t of turns) if (ids.includes(t.id)) t.revertedAt = new Date(0);
      return Promise.resolve();
    },
    latestMessageId: () => Promise.resolve("m_latest"),
    softDeleteMessagesAfter(channelId, after) {
      softDeleted.push({ channelId, after });
      return Promise.resolve(after ? 3 : 0);
    },
  };

  return { deps, launches, proposals, turns, reverted, softDeleted };
}

const base = {
  workspaceId: "ws_1",
  channelId: "ch_1",
  agentMemberId: "mem_agent",
  createdByMemberId: "mem_human",
};

// --- tests ------------------------------------------------------------------

describe("TurnController.propose (#53 — plan mode blocks until approval)", () => {
  it("runs a plan-mode session and persists a proposed plan, launching no execution", async () => {
    const { deps, launches, proposals } = makeDeps();
    const c = new TurnController(deps);
    const r = await c.propose({ ...base, originalTask: "ship X" });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.status).toBe("proposed");
    expect(r.proposal.planText).toContain("1. read");
    // exactly one launch — the plan-mode run — and NO execution
    expect(launches).toHaveLength(1);
    expect(launches[0]?.harnessEnv?.AGENT_PLAN_MODE).toBe("1");
    expect(launches[0]?.task).toBe("ship X");
    expect(proposals).toHaveLength(1);
  });

  it("422s when the plan-mode run produced no plan block", async () => {
    const { deps } = makeDeps({ planOutput: "agent: I did some work but no plan" });
    const r = await new TurnController(deps).propose({ ...base, originalTask: "ship X" });
    expect(r).toMatchObject({ ok: false, code: 422 });
  });
});

describe("TurnController.decide (#53)", () => {
  async function seeded() {
    const ctx = makeDeps();
    const c = new TurnController(ctx.deps);
    await c.propose({ ...base, originalTask: "ship X" });
    ctx.launches.length = 0; // forget the plan launch; focus on the decision
    return { ctx, c, proposalId: ctx.proposals[0]!.id };
  }

  it("approve launches the execution with the plan composed into its task", async () => {
    const { ctx, c, proposalId } = await seeded();
    const r = await c.decide({ ...base, proposalId, decision: "approve", decidedByMemberId: "mem_human" });
    expect(r).toMatchObject({ ok: true, status: "approved" });
    expect(ctx.launches).toHaveLength(1);
    expect(ctx.launches[0]?.task).toContain("1. read"); // the plan is in the execution task
    expect(ctx.launches[0]?.harnessEnv).toBeUndefined(); // execution is NOT plan mode
    expect(ctx.proposals[0]?.executionSessionId).toBeTruthy();
  });

  it("approve_with_feedback threads the feedback into the execution task", async () => {
    const { ctx, c, proposalId } = await seeded();
    const r = await c.decide({
      ...base,
      proposalId,
      decision: "approve_with_feedback",
      feedback: "write tests first",
      decidedByMemberId: "mem_human",
    });
    expect(r).toMatchObject({ ok: true, status: "approved_with_feedback" });
    expect(ctx.launches[0]?.task).toContain("write tests first");
    expect(ctx.proposals[0]?.feedback).toBe("write tests first");
  });

  it("reject launches nothing", async () => {
    const { ctx, c, proposalId } = await seeded();
    const r = await c.decide({ ...base, proposalId, decision: "reject", decidedByMemberId: "mem_human" });
    expect(r).toMatchObject({ ok: true, status: "rejected", executionSessionId: null });
    expect(ctx.launches).toHaveLength(0);
    expect(ctx.proposals[0]?.status).toBe("rejected");
  });

  it("409s a second decision and 400s invalid input; 404s an unknown proposal", async () => {
    const { ctx, c, proposalId } = await seeded();
    await c.decide({ ...base, proposalId, decision: "approve", decidedByMemberId: "mem_human" });
    const second = await c.decide({ ...base, proposalId, decision: "reject", decidedByMemberId: "mem_human" });
    expect(second).toMatchObject({ ok: false, code: 409 });

    const { c: c2, proposalId: pid2 } = await seeded();
    const bad = await c2.decide({
      ...base,
      proposalId: pid2,
      decision: "approve",
      feedback: "not allowed here",
      decidedByMemberId: "mem_human",
    });
    expect(bad).toMatchObject({ ok: false, code: 400 });

    const missing = await c2.decide({ ...base, proposalId: "nope", decision: "approve", decidedByMemberId: "mem_human" });
    expect(missing).toMatchObject({ ok: false, code: 404 });
    void ctx;
  });
});

describe("TurnController.checkpoint (#53)", () => {
  it("records the baseline at idx 0 from the worktree HEAD, then work turns from commits", async () => {
    const git = new FakeGit();
    git.head = "headBASE";
    git.commitShas = ["headA", "headB"];
    const { deps, turns } = makeDeps({ git });
    const c = new TurnController(deps);

    const t0 = await c.checkpoint({ ...base, sessionId: "sess_exec", createdByMemberId: "mem_human" });
    expect(t0).toMatchObject({ ok: true });
    if (t0.ok) expect(t0.turn).toMatchObject({ idx: 0, kind: "baseline", headSha: "headBASE" });

    const t1 = await c.checkpoint({ ...base, sessionId: "sess_exec", createdByMemberId: "mem_human" });
    if (t1.ok) expect(t1.turn).toMatchObject({ idx: 1, kind: "work", headSha: "headA" });
    expect(turns).toHaveLength(2);
  });

  it("501s when no git workspace is configured", async () => {
    const { deps } = makeDeps({ git: null });
    const r = await new TurnController(deps).checkpoint({ ...base, sessionId: "s", createdByMemberId: "h" });
    expect(r).toMatchObject({ ok: false, code: 501 });
  });
});

describe("TurnController.revert (#53 — files + conversation together)", () => {
  async function withTurns() {
    const git = new FakeGit();
    git.head = "headBASE";
    git.commitShas = ["headA", "headB"];
    const ctx = makeDeps({ git });
    const c = new TurnController(ctx.deps);
    // baseline (idx0), turn1 (idx1, headA), turn2 (idx2, headB)
    await c.checkpoint({ ...base, sessionId: "sess_exec", createdByMemberId: "mem_human" });
    await c.checkpoint({ ...base, sessionId: "sess_exec", createdByMemberId: "mem_human" });
    await c.checkpoint({ ...base, sessionId: "sess_exec", createdByMemberId: "mem_human" });
    return { ctx, c, git };
  }

  it("reverting the latest turn resets to the previous snapshot and truncates the conversation", async () => {
    const { ctx, c, git } = await withTurns();
    const turn2 = ctx.turns.find((t) => t.idx === 2)!;
    const r = await c.revert({ channelId: base.channelId, sessionId: "sess_exec", turnId: turn2.id });

    expect(r).toMatchObject({ ok: true, restoreSha: "headA" });
    if (r.ok) expect(r.discardedTurnIds).toEqual([turn2.id]);
    expect(git.resets).toEqual([{ key: "sess_exec", sha: "headA" }]);
    expect(ctx.softDeleted).toHaveLength(1);
    expect(turn2.revertedAt).not.toBeNull();
  });

  it("refuses to revert the baseline (400) or an unknown turn (404), and 501s without git", async () => {
    const { ctx, c } = await withTurns();
    const baseline = ctx.turns.find((t) => t.idx === 0)!;
    expect(await c.revert({ channelId: base.channelId, sessionId: "sess_exec", turnId: baseline.id })).toMatchObject({
      ok: false,
      code: 400,
    });
    expect(await c.revert({ channelId: base.channelId, sessionId: "sess_exec", turnId: "nope" })).toMatchObject({
      ok: false,
      code: 404,
    });

    const { deps } = makeDeps({ git: null });
    expect(await new TurnController(deps).revert({ channelId: "c", sessionId: "s", turnId: "t" })).toMatchObject({
      ok: false,
      code: 501,
    });
  });
});
