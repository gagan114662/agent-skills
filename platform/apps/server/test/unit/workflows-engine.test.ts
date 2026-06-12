import { describe, it, expect, beforeEach } from "vitest";
import { WorkflowEngine, type WorkflowStore } from "../../src/workflows/engine.js";
import type { WorkflowCaps } from "../../src/workflows/caps.js";
import type { FailureEvent } from "../../src/flywheel/types.js";
import type { WorkflowRecord, WorkflowRun } from "../../src/workflows/types.js";

/**
 * Engine-level unit test (#152): the REAL pure decision core (`decide` + `conditions`) driven over a
 * fully in-memory store + fake action seams — no DB, no model spend. Proves action execution, the
 * status rollup, the conditions gate, and the #117 flywheel feed on a failed firing.
 */

const silentLogger = { info() {}, warn() {}, error() {}, child() { return this; } } as never;

function makeStore(): WorkflowStore & { runs: WorkflowRun[] } {
  const runs: WorkflowRun[] = [];
  let seq = 0;
  return {
    runs,
    async recordRun(input) {
      const run: WorkflowRun = {
        id: `run-${seq++}`,
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        trigger: input.trigger,
        status: input.status,
        reason: input.reason,
        results: input.results,
        createdAt: new Date("2026-06-12T12:00:00.000Z"),
      };
      runs.push(run);
      return run;
    },
    async countRunsInWindow() {
      return 0;
    },
    // unused by these scenarios:
    async create() { throw new Error("unused"); },
    async get() { return null; },
    async list() { return []; },
    async countForWorkspace() { return 0; },
    async setEnabled() { return null; },
    async remove() { return false; },
    async listDue() { return []; },
    async listByTrigger() { return []; },
    async markFired() {},
    async listRuns() { return runs; },
    async findByWebhookHash() { return null; },
    async activeWorkspaces() { return []; },
  };
}

const CAPS: WorkflowCaps = {
  enabled: true,
  maxRunsPerWindow: 50,
  windowMinutes: 1440,
  maxPerWorkspace: 50,
  maxActionsPerRun: 10,
};

function workflow(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    id: "wf-1",
    workspaceId: "ws-1",
    name: "Weekly SEO",
    triggerKind: "schedule",
    trigger: { kind: "schedule", schedule: { cadence: "weekly", dayOfWeek: 1, hour: 9, minute: 0 } },
    conditions: [],
    actions: [{ kind: "agent_task", channelId: "ch-1", agentHandle: "scout", task: "Audit the site." }],
    enabled: true,
    createdByMemberId: "m-1",
    lastFiredAt: null,
    nextRunAt: new Date("2026-06-12T09:00:00.000Z"),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("WorkflowEngine.runWorkflow (#152)", () => {
  let launches: number;
  let drafts: number;
  let notifies: number;
  let flywheel: FailureEvent[];
  let store: ReturnType<typeof makeStore>;

  function makeEngine(opts: { launchThrows?: boolean; agentSeeded?: boolean } = {}): WorkflowEngine {
    return new WorkflowEngine({
      store,
      launcher: {
        launch: async () => {
          launches++;
          if (opts.launchThrows) throw new Error("admission denied");
          return { id: "sess-1" };
        },
      },
      draftSendGate: {
        submit: async () => {
          drafts++;
          return { approvalRequestId: "appr-1" };
        },
      },
      notifier: {
        notifyOwner: async () => {
          notifies++;
          return { id: "notif-1" };
        },
      },
      resolveAgentMember: async () => (opts.agentSeeded === false ? null : { agentMemberId: "agent-1" }),
      resolveFacts: async () => ({ catalog: { site: { active: 1 } } }),
      caps: () => CAPS,
      killSwitch: async () => false,
      flywheelRecord: async (e) => {
        flywheel.push(e);
        return undefined;
      },
      logger: silentLogger,
      now: () => new Date("2026-06-12T12:00:00.000Z"),
    });
  }

  beforeEach(() => {
    launches = 0;
    drafts = 0;
    notifies = 0;
    flywheel = [];
    store = makeStore();
  });

  it("fires an agent_task through the gated launcher and records a fired run", async () => {
    const run = await makeEngine().runWorkflow(workflow(), "manual");
    expect(run.status).toBe("fired");
    expect(launches).toBe(1);
    expect(run.results).toEqual([{ kind: "agent_task", status: "ok", reason: "launched", ref: "sess-1" }]);
    expect(flywheel).toHaveLength(0);
  });

  it("runs all three action kinds in order; draft_send becomes a PENDING approval (no egress)", async () => {
    const wf = workflow({
      actions: [
        { kind: "agent_task", channelId: "ch-1", agentHandle: "scout", task: "Draft a post." },
        { kind: "draft_send", sendKind: "social.post", summary: "Launch tweet" },
        { kind: "notify_owner", message: "Heads up" },
      ],
    });
    const run = await makeEngine().runWorkflow(wf, "manual");
    expect(run.status).toBe("fired");
    expect({ launches, drafts, notifies }).toEqual({ launches: 1, drafts: 1, notifies: 1 });
    expect(run.results.map((r) => `${r.kind}:${r.status}`)).toEqual([
      "agent_task:ok",
      "draft_send:ok",
      "notify_owner:ok",
    ]);
    // the draft_send produced an approval reference, not a send
    expect(run.results[1]).toMatchObject({ status: "ok", reason: "approval_pending", ref: "appr-1" });
  });

  it("skips when conditions are not met (no actions run)", async () => {
    const wf = workflow({ conditions: [{ fact: "catalog.site.active", op: "gt", value: 5 }] });
    const run = await makeEngine().runWorkflow(wf, "manual");
    expect(run.status).toBe("skipped");
    expect(run.reason).toBe("conditions_unmet:condition_0");
    expect(launches).toBe(0);
  });

  it("fires when conditions ARE met", async () => {
    const wf = workflow({ conditions: [{ fact: "catalog.site.active", op: "gte", value: 1 }] });
    const run = await makeEngine().runWorkflow(wf, "manual");
    expect(run.status).toBe("fired");
    expect(launches).toBe(1);
  });

  it("blocks (not fails) when the agent is not seeded — no flywheel feed", async () => {
    const run = await makeEngine({ agentSeeded: false }).runWorkflow(workflow(), "manual");
    expect(run.status).toBe("blocked");
    expect(run.results[0]).toMatchObject({ kind: "agent_task", status: "blocked", reason: "agent_not_seeded" });
    expect(flywheel).toHaveLength(0);
  });

  it("an admission denial is a blocked action, not a failed run", async () => {
    const run = await makeEngine({ launchThrows: true }).runWorkflow(workflow(), "manual");
    expect(run.status).toBe("blocked");
    expect(run.results[0]).toMatchObject({ status: "blocked", reason: "admission denied" });
    expect(flywheel).toHaveLength(0);
  });

  it("a thrown action ⇒ failed run that feeds the #117 flywheel as workflow_fail", async () => {
    // notify_owner whose seam throws → failed action → failed run.
    const engine = new WorkflowEngine({
      store,
      launcher: { launch: async () => ({ id: "s" }) },
      draftSendGate: { submit: async () => ({ approvalRequestId: "a" }) },
      notifier: { notifyOwner: async () => { throw new Error("notifier down"); } },
      resolveAgentMember: async () => ({ agentMemberId: "agent-1" }),
      resolveFacts: async () => ({}),
      caps: () => CAPS,
      killSwitch: async () => false,
      flywheelRecord: async (e) => { flywheel.push(e); return undefined; },
      logger: silentLogger,
      now: () => new Date("2026-06-12T12:00:00.000Z"),
    });
    const wf = workflow({ actions: [{ kind: "notify_owner", message: "hi" }] });
    const run = await engine.runWorkflow(wf, "manual");
    expect(run.status).toBe("failed");
    expect(flywheel).toHaveLength(1);
    expect(flywheel[0]).toMatchObject({ failureClass: "workflow_fail", workspaceId: "ws-1" });
  });

  it("the kill switch skips before any action", async () => {
    const engine = new WorkflowEngine({
      store,
      launcher: { launch: async () => { launches++; return { id: "s" }; } },
      draftSendGate: { submit: async () => ({ approvalRequestId: "a" }) },
      notifier: { notifyOwner: async () => ({ id: "n" }) },
      resolveAgentMember: async () => ({ agentMemberId: "agent-1" }),
      resolveFacts: async () => ({}),
      caps: () => CAPS,
      killSwitch: async () => true,
      logger: silentLogger,
      now: () => new Date("2026-06-12T12:00:00.000Z"),
    });
    const run = await engine.runWorkflow(workflow(), "manual");
    expect(run.status).toBe("skipped");
    expect(run.reason).toBe("kill_switch");
    expect(launches).toBe(0);
  });
});
