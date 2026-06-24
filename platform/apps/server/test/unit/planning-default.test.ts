import { describe, expect, it } from "vitest";
import { specDispatcherFrom } from "../../src/planning/default.js";
import type { BacklogItemRecord, PlanningSpecRecord } from "../../src/planning/types.js";
import type { SessionManager } from "../../src/runtime/manager.js";

const NOW = new Date("2026-06-24T00:00:00Z");
const WS = "ws-962";

function item(over: Partial<BacklogItemRecord> = {}): BacklogItemRecord {
  return {
    id: "item-1",
    workspaceId: WS,
    ideaId: null,
    title: "Improve homepage positioning",
    description: "Make the homepage sharper",
    source: "manual",
    sourceRef: "manual:item-1",
    reach: 10,
    impact: 3,
    confidencePct: 90,
    effort: 2,
    isPivot: false,
    status: "proposed",
    targetChannelId: "ch-1",
    targetAgentMemberId: "agent-1",
    specId: "spec-1",
    approvalRequestId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function spec(over: Partial<PlanningSpecRecord> = {}): PlanningSpecRecord {
  return {
    id: "spec-1",
    workspaceId: WS,
    backlogItemId: "item-1",
    title: "Homepage positioning",
    body: "Rewrite the hero around founder activation.",
    status: "draft",
    sessionId: null,
    approvalRequestId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe("planning default dispatcher workspace context (#962)", () => {
  it("enriches autonomy-dispatched launch tasks before calling the launcher", async () => {
    const launches: Array<{
      workspaceId: string;
      task: string;
      harnessEnv?: Record<string, string>;
    }> = [];
    const enrichCalls: Array<{ workspaceId: string; task: string }> = [];
    const dispatcher = specDispatcherFrom({} as SessionManager, {
      launcher: {
        async launch(input) {
          launches.push(input);
          return { id: "session-1" };
        },
      },
      enrichTask: async (workspaceId, task) => {
        enrichCalls.push({ workspaceId, task });
        return `WORKSPACE CONTEXT\n\n---\n\n${task}`;
      },
    });

    await dispatcher.dispatch({ workspaceId: WS, item: item(), spec: spec() });

    expect(enrichCalls).toEqual([
      {
        workspaceId: WS,
        task: 'Implement the spec "Homepage positioning" (backlog item item-1).\n\nRewrite the hero around founder activation.',
      },
    ]);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.task).toBe(
      'WORKSPACE CONTEXT\n\n---\n\nImplement the spec "Homepage positioning" (backlog item item-1).\n\nRewrite the hero around founder activation.',
    );
    expect(launches[0]!.harnessEnv).toEqual({ AGENT_PLANNING_DISPATCH: "1" });
  });

  it("falls back to the raw planning task if enrichment fails", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const launches: Array<{ task: string }> = [];
    const dispatcher = specDispatcherFrom({} as SessionManager, {
      launcher: {
        async launch(input) {
          launches.push(input);
          return { id: "session-1" };
        },
      },
      enrichTask: async () => {
        throw new Error("context store down");
      },
      logger: {
        warn(obj) {
          warnings.push(obj);
        },
      },
    });

    await dispatcher.dispatch({ workspaceId: WS, item: item(), spec: spec() });

    expect(launches[0]!.task).toBe(
      'Implement the spec "Homepage positioning" (backlog item item-1).\n\nRewrite the hero around founder activation.',
    );
    expect(warnings[0]).toMatchObject({
      workspaceId: WS,
      backlogItemId: "item-1",
      specId: "spec-1",
    });
  });
});
