import { describe, it, expect } from "vitest";
import { normalizeAuditEvents, type AuditInput } from "../../src/audit/normalize.js";

const labelFor = (id: string | null) => (id === "m1" ? "Alice" : id === "agent1" ? "Scout" : "system");

const base: AuditInput = {
  approvals: [
    {
      id: "ap1",
      requesterMemberId: "m1",
      actionType: "external.send",
      summary: "Post launch tweet",
      status: "pending",
      createdAt: new Date("2026-06-08T09:00:00.000Z"),
    },
  ],
  runs: [
    {
      id: "r1",
      automationId: "auto1",
      trigger: "schedule",
      status: "launched",
      reason: "due",
      task: "Run an SEO audit of ipop.ai ...",
      createdAt: new Date("2026-06-08T09:30:00.000Z"),
    },
    {
      id: "r2",
      automationId: "auto1",
      trigger: "schedule",
      status: "skipped",
      reason: "rate_limited",
      task: "",
      createdAt: new Date("2026-06-08T08:00:00.000Z"),
    },
  ],
  launches: [
    {
      id: "l1",
      department: "seo",
      agentMemberId: "agent1",
      kind: "mention",
      task: "audit the homepage",
      status: "launched",
      createdByMemberId: "m1",
      createdAt: new Date("2026-06-08T10:00:00.000Z"),
    },
  ],
  labelFor,
};

describe("audit normalize (#147)", () => {
  it("merges three sources, newest first, resolving actor labels + gates", () => {
    const events = normalizeAuditEvents(base);
    expect(events.map((e) => e.ref)).toEqual(["l1", "r1", "ap1", "r2"]);
    expect(events[0]).toMatchObject({
      source: "agent",
      kind: "agent.mention",
      actorLabel: "Scout",
      gatedBy: "venture+budget",
    });
    const approval = events.find((e) => e.ref === "ap1")!;
    expect(approval).toMatchObject({ source: "approval", kind: "approval.external.send", gatedBy: "approval", actorLabel: "Alice" });
  });

  it("summarizes a launched run vs a skipped run distinctly", () => {
    const events = normalizeAuditEvents(base);
    expect(events.find((e) => e.ref === "r1")!.summary).toContain("Automation launched");
    expect(events.find((e) => e.ref === "r2")!.summary).toContain("rate_limited");
  });

  it("labels an unknown actor as system and caps the feed", () => {
    const events = normalizeAuditEvents({
      ...base,
      approvals: Array.from({ length: 10 }, (_, i) => ({
        id: `ap${i}`,
        requesterMemberId: "ghost",
        actionType: "chat.post_message",
        summary: "",
        status: "executed",
        createdAt: new Date(`2026-06-08T0${i}:00:00.000Z`),
      })),
      runs: [],
      launches: [],
      limit: 3,
    });
    expect(events).toHaveLength(3);
    expect(events[0].actorLabel).toBe("system");
    expect(events[0].summary).toBe("chat.post_message requested");
  });

  it("handles all-empty inputs", () => {
    expect(normalizeAuditEvents({ approvals: [], runs: [], launches: [], labelFor })).toEqual([]);
  });
});
