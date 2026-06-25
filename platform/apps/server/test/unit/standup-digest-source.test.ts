import { describe, expect, it } from "vitest";
import { RepositoryDailyActivitySource } from "../../src/standup-digest/source.js";

describe("RepositoryDailyActivitySource", () => {
  it("groups real repository activity by agent with receipt links", async () => {
    const source = new RepositoryDailyActivitySource({
      async listAgents() {
        return [
          { id: "agent-a", name: "Builder", role: "codex" },
          { id: "agent-b", name: "Reviewer", role: "review" },
        ];
      },
      async listSessions(_workspaceId, from, to) {
        expect(from.toISOString()).toBe("2026-06-24T00:00:00.000Z");
        expect(to.toISOString()).toBe("2026-06-25T00:00:00.000Z");
        return [
          {
            id: "sess-1",
            agentMemberId: "agent-a",
            agentName: "Builder",
            command: "implement the digest",
            status: "completed",
            result: "Merged standup digest wiring",
            headSha: "abcdef123456",
            branch: "fix/589",
            createdAt: from,
            endedAt: from,
          },
          {
            id: "sess-2",
            agentMemberId: "agent-b",
            agentName: "Reviewer",
            command: "review checks",
            status: "failed",
            result: "typecheck failed",
            createdAt: from,
            endedAt: from,
          },
        ];
      },
      async listDecisions() {
        return [
          {
            id: "dec-1",
            decidedByMemberId: "agent-a",
            title: "Use durable stores instead of raw logs",
            rationale: "The digest should link to receipts",
            createdAt: new Date("2026-06-24T12:00:00.000Z"),
          },
        ];
      },
      async listArtifacts() {
        return [
          {
            id: "art-1",
            tool: "publish_site",
            provider: "vercel",
            status: "published",
            url: "https://example.com/digest",
            detail: "Published digest console",
            createdAt: new Date("2026-06-24T13:00:00.000Z"),
          },
          {
            id: "art-2",
            tool: "send_email",
            provider: "postmark",
            status: "blocked",
            url: null,
            detail: "Missing sender verification",
            createdAt: new Date("2026-06-24T14:00:00.000Z"),
          },
        ];
      },
      async listOpenTasks() {
        return [
          {
            id: "task-1",
            title: "Run digest checks tomorrow",
            description: null,
            status: "todo",
            assigneeMemberId: "agent-a",
            updatedAt: new Date("2026-06-24T15:00:00.000Z"),
          },
          {
            id: "task-2",
            title: "Waiting on production database URL",
            description: null,
            status: "blocked",
            assigneeMemberId: "agent-b",
            updatedAt: new Date("2026-06-24T15:30:00.000Z"),
          },
        ];
      },
    });

    const data = await source.fetch("ws-1", { day: "2026-06-24" });
    const builder = data.agents.find((a) => a.agentId === "agent-a");
    const reviewer = data.agents.find((a) => a.agentId === "agent-b");
    const artifacts = data.agents.find((a) => a.agentId === "workspace-artifacts");

    expect(builder?.artifacts[0]).toMatchObject({
      id: "session:sess-1",
      title: "Merged standup digest wiring (abcdef1)",
      receipt: { url: "/workspaces/ws-1/agent-sessions/sess-1" },
    });
    expect(builder?.decisions[0]?.receipt?.url).toBe("/workspaces/ws-1/decisions/dec-1");
    expect(builder?.planned[0]).toMatchObject({
      summary: "Run digest checks tomorrow",
      receipt: { url: "/workspaces/ws-1/tasks/task-1" },
    });
    expect(reviewer?.blockers.map((b) => b.summary)).toEqual([
      "failed: typecheck failed",
      "Waiting on production database URL",
    ]);
    expect(artifacts?.artifacts[0]?.receipt?.url).toBe("https://example.com/digest");
    expect(artifacts?.blockers[0]?.receipt?.url).toBe("/workspaces/ws-1/realworld-artifacts/art-2");
  });

  it("returns only agents with activity", async () => {
    const source = new RepositoryDailyActivitySource({
      async listAgents() {
        return [{ id: "idle", name: "Idle" }];
      },
      async listSessions() {
        return [];
      },
      async listDecisions() {
        return [];
      },
      async listArtifacts() {
        return [];
      },
      async listOpenTasks() {
        return [];
      },
    });

    await expect(source.fetch("ws-1", { day: "2026-06-24" })).resolves.toMatchObject({
      workspaceId: "ws-1",
      agents: [],
    });
  });
});
