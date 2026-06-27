import { describe, it, expect } from "vitest";
import { normalizeAuditEvents, type AuditInput } from "../../src/audit/normalize.js";

const labelFor = (id: string | null) =>
  id === "m1" ? "Alice" : id === "agent1" ? "Scout" : "system";

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
  credentials: [
    {
      id: "cred1",
      serviceKey: "email",
      action: "connected",
      actorMemberId: "m1",
      fingerprint: "fp_secretless",
      envKeys: ["SENDGRID_API_KEY"],
      scopes: ["email.send"],
      createdAt: new Date("2026-06-08T10:30:00.000Z"),
    },
  ],
  codexReceipts: [],
  labelFor,
};

describe("audit normalize (#147)", () => {
  it("merges three sources, newest first, resolving actor labels + gates", () => {
    const events = normalizeAuditEvents(base);
    expect(events.map((e) => e.ref)).toEqual(["cred1", "l1", "r1", "ap1", "r2"]);
    expect(events[1]).toMatchObject({
      source: "agent",
      kind: "agent.mention",
      actorLabel: "Scout",
      gatedBy: "venture+budget",
    });
    const approval = events.find((e) => e.ref === "ap1")!;
    expect(approval).toMatchObject({
      source: "approval",
      kind: "approval.external.send",
      gatedBy: "approval",
      actorLabel: "Alice",
    });
  });

  it("surfaces credential lifecycle events without secrets", () => {
    const credential = normalizeAuditEvents(base).find((e) => e.ref === "cred1")!;
    expect(credential).toMatchObject({
      source: "credential",
      kind: "credential.connected",
      actorMemberId: "m1",
      actorLabel: "Alice",
      gatedBy: "none",
      status: "connected",
      summary: "email credentials connected scopes=email.send env=SENDGRID_API_KEY",
    });
    expect(JSON.stringify(credential)).not.toContain("fp_secretless");
  });

  it("surfaces Codex operator returned work as a labelled audit receipt (#1265)", () => {
    const events = normalizeAuditEvents({
      ...base,
      approvals: [],
      runs: [],
      launches: [],
      credentials: [],
      codexReceipts: [
        {
          id: "codex1",
          actorMemberId: "agent1",
          body:
            "codex_operator_lane receipt\n" +
            "Returned through the signed-in team-engine lane; no API keys, cookies, passwords, or browser session secrets were requested.\n\n" +
            "summary: opened PR #1353 and verified the route",
          createdAt: new Date("2026-06-08T11:00:00.000Z"),
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ref: "codex1",
      source: "agent",
      kind: "agent.codex_operator_lane.returned",
      actorLabel: "Scout",
      gatedBy: "none",
      status: "returned",
      summary: "Codex operator lane returned: summary: opened PR #1353 and verified the route",
    });
    expect(JSON.stringify(events[0])).not.toContain("API keys");
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
      credentials: [],
      limit: 3,
    });
    expect(events).toHaveLength(3);
    expect(events[0].actorLabel).toBe("system");
    expect(events[0].summary).toBe("chat.post_message requested");
  });

  it("handles all-empty inputs", () => {
    expect(
      normalizeAuditEvents({ approvals: [], runs: [], launches: [], credentials: [], labelFor }),
    ).toEqual([]);
  });
});
