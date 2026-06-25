import { describe, expect, it } from "vitest";
import {
  dogfoodPhaseForTraceType,
  projectDogfoodFeed,
  scrubPublicDogfoodText,
} from "../../src/public-dogfood/project.js";
import { publicDogfoodRoutes } from "../../src/routes/public-dogfood.js";
import type { TraceEvent, TraceRun } from "../../src/trace/types.js";
import Fastify from "fastify";

function run(partial: Partial<TraceRun> = {}): TraceRun {
  return {
    id: partial.id ?? "run-private-1",
    workspaceId: partial.workspaceId ?? "ws-private-1",
    sessionId: partial.sessionId ?? null,
    agentMemberId: partial.agentMemberId ?? "agent-private-1",
    taskId: partial.taskId ?? "task-private-1",
    label: partial.label ?? "ipop SEO dogfood",
    status: partial.status ?? "closed",
    eventCount: partial.eventCount ?? 2,
    inputTokens: partial.inputTokens ?? 0,
    outputTokens: partial.outputTokens ?? 0,
    costMicros: partial.costMicros ?? 0,
    startedAt: partial.startedAt ?? new Date("2026-06-25T09:00:00.000Z"),
    endedAt: partial.endedAt ?? new Date("2026-06-25T09:10:00.000Z"),
  };
}

function event(partial: Partial<TraceEvent> & Pick<TraceEvent, "id" | "seq" | "type">): TraceEvent {
  return {
    id: partial.id,
    runId: partial.runId ?? "run-private-1",
    seq: partial.seq,
    type: partial.type,
    turn: partial.turn ?? 0,
    label: partial.label ?? null,
    payload: partial.payload ?? {},
    inputTokens: partial.inputTokens ?? null,
    outputTokens: partial.outputTokens ?? null,
    costMicros: partial.costMicros ?? null,
    occurredAt: partial.occurredAt ?? new Date("2026-06-25T09:05:00.000Z"),
  };
}

describe("dogfoodPhaseForTraceType", () => {
  it("maps trace events to the public dogfood phases", () => {
    expect(dogfoodPhaseForTraceType("model_request")).toBe("thinking");
    expect(dogfoodPhaseForTraceType("model_response")).toBe("thinking");
    expect(dogfoodPhaseForTraceType("tool_call")).toBe("tool");
    expect(dogfoodPhaseForTraceType("tool_result")).toBe("artifact");
    expect(dogfoodPhaseForTraceType("approval_decision")).toBe("approval");
  });
});

describe("scrubPublicDogfoodText", () => {
  it("removes known private ids, obvious tokens, and email addresses", () => {
    const out = scrubPublicDogfoodText(
      "run-private-1 used sk-proj-abcdefghi and emailed founder@example.com with Bearer abcdefghijklmnop",
      ["run-private-1"],
    );
    expect(out).not.toContain("run-private-1");
    expect(out).not.toContain("sk-proj-abcdefghi");
    expect(out).not.toContain("founder@example.com");
    expect(out).not.toContain("Bearer abcdefghijklmnop");
    expect(out).toContain("[redacted]");
  });
});

describe("projectDogfoodFeed", () => {
  it("projects real trace events into public receipts without raw private identifiers", () => {
    const feed = projectDogfoodFeed({
      slug: "ipop",
      workspaceName: "ipop.ai",
      runs: [
        {
          run: run(),
          events: [
            event({
              id: "event-private-1",
              seq: 1,
              type: "model_response",
              payload: { reasoning: "Found a pricing-page SEO gap for ws-private-1" },
              occurredAt: new Date("2026-06-25T09:04:00.000Z"),
            }),
            event({
              id: "event-private-2",
              seq: 2,
              type: "tool_result",
              label: "seo_audit",
              payload: { output: "Drafted meta description and saved artifact for run-private-1" },
              occurredAt: new Date("2026-06-25T09:06:00.000Z"),
            }),
          ],
        },
      ],
    });

    expect(feed).toMatchObject({
      slug: "ipop",
      workspaceName: "ipop.ai",
      title: "ipop is marketing itself with ipop",
      lastUpdatedAt: "2026-06-25T09:06:00.000Z",
    });
    expect(feed.receipts).toHaveLength(2);
    expect(feed.receipts[0]).toMatchObject({
      phase: "artifact",
      artifactLabel: "seo_audit",
      summary: "Drafted meta description and saved artifact for [redacted]",
    });

    const json = JSON.stringify(feed);
    expect(json).not.toContain("run-private-1");
    expect(json).not.toContain("ws-private-1");
    expect(json).not.toContain("event-private");
    expect(json).not.toContain("agent-private-1");
    expect(json).not.toContain("task-private-1");
  });

  it("keeps an honest empty feed when there are no public receipts", () => {
    const feed = projectDogfoodFeed({ slug: "ipop", workspaceName: "ipop.ai", runs: [] });
    expect(feed.lastUpdatedAt).toBeNull();
    expect(feed.receipts).toEqual([]);
  });

  it("derives blocked and outcome phases from labels", () => {
    const feed = projectDogfoodFeed({
      slug: "ipop",
      workspaceName: "ipop.ai",
      runs: [
        {
          run: run({ id: "run-2" }),
          events: [
            event({
              id: "e1",
              runId: "run-2",
              seq: 1,
              type: "tool_result",
              label: "blocked_no_channel",
              occurredAt: new Date("2026-06-25T09:05:00.000Z"),
            }),
            event({
              id: "e2",
              runId: "run-2",
              seq: 2,
              type: "tool_result",
              label: "published_story_outcome",
              occurredAt: new Date("2026-06-25T09:06:00.000Z"),
            }),
          ],
        },
      ],
    });
    expect(feed.receipts.map((r) => r.phase)).toEqual(["outcome", "blocked"]);
  });
});

describe("publicDogfoodRoutes", () => {
  it("404s by default when a slug is not explicitly enabled", async () => {
    const app = Fastify();
    await app.register(publicDogfoodRoutes, {
      traceService: {
        async listRuns() {
          throw new Error("should not read traces for disabled slugs");
        },
        async getTrace() {
          throw new Error("should not read traces for disabled slugs");
        },
      },
    });

    const res = await app.inject({ method: "GET", url: "/dogfood/ipop" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns an enabled workspace feed through the public projection", async () => {
    const app = Fastify();
    await app.register(publicDogfoodRoutes, {
      enabledSlugs: ["ipop"],
      resolveWorkspace: async (slug) => (slug === "ipop" ? { id: "ws-private-1", name: "ipop.ai" } : undefined),
      traceService: {
        async listRuns(workspaceId) {
          expect(workspaceId).toBe("ws-private-1");
          return [run()];
        },
        async getTrace(workspaceId, runId) {
          expect(workspaceId).toBe("ws-private-1");
          expect(runId).toBe("run-private-1");
          return {
            run: run(),
            events: [
              event({
                id: "event-private-1",
                seq: 1,
                type: "tool_result",
                label: "seo_audit",
                payload: { output: "Audited /pricing for ws-private-1 with sk-proj-abcdefghi" },
              }),
            ],
          };
        },
      },
    });

    const res = await app.inject({ method: "GET", url: "/dogfood/ipop" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.receipts[0]).toMatchObject({
      phase: "artifact",
      summary: "Audited /pricing for [redacted] with [redacted]",
    });
    expect(JSON.stringify(body)).not.toContain("ws-private-1");
    expect(JSON.stringify(body)).not.toContain("run-private-1");
    expect(JSON.stringify(body)).not.toContain("event-private-1");
    expect(JSON.stringify(body)).not.toContain("sk-proj-abcdefghi");
    await app.close();
  });
});
