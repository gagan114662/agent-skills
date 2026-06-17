/**
 * Pure console-model tests. The board (by status) and the standup (by project) are two groupings of the
 * same items, derived from the real seams (live sessions, #13 approvals, channels, directory). These lock
 * the status grammar, the department-hue resolution, the approval→department-channel mapping, and the
 * spend forecast.
 */
import { describe, expect, it } from "vitest";
import type { ApprovalRequestDto } from "@reload/shared";
import type { Channel, LiveSessionDto } from "../../api/types.js";
import { departmentColor } from "../../brand.js";
import {
  buildConsole,
  brailleFrame,
  BRAILLE_FRAMES,
  spendForecast,
  type DirectoryEntry,
} from "./model.js";

const channels: Channel[] = [
  { id: "c-seo", workspaceId: "w1", kind: "public", name: "seo", isArchived: false },
  { id: "c-email", workspaceId: "w1", kind: "public", name: "email", isArchived: false },
  { id: "c-dm", workspaceId: "w1", kind: "dm", name: null, isArchived: false },
];

const directory: Record<string, DirectoryEntry> = {
  "ag-scout": { id: "ag-scout", kind: "agent", displayName: "Scout" },
  "ag-postmark": { id: "ag-postmark", kind: "agent", displayName: "Postmark" },
};

function session(over: Partial<LiveSessionDto> & { id: string }): LiveSessionDto {
  return {
    channelId: "c-seo",
    agentMemberId: "ag-scout",
    status: "running",
    elapsedMs: 60_000,
    estimatedCostCents: 84,
    startedAt: null,
    progressAt: "2026-06-12T09:00:00Z",
    ...over,
  };
}

function approval(over: Partial<ApprovalRequestDto> & { id: string }): ApprovalRequestDto {
  return {
    workspaceId: "w1",
    requesterMemberId: "ag-postmark",
    actionType: "external.send",
    payload: {},
    amount: null,
    summary: "Send launch emails",
    status: "pending",
    reason: null,
    decidedByMemberId: null,
    decidedAt: null,
    expiresAt: null,
    result: null,
    error: null,
    createdAt: "2026-06-12T09:00:00Z",
    updatedAt: "2026-06-12T09:00:00Z",
    ...over,
  };
}

describe("buildConsole — status grammar + hues", () => {
  it("maps a live session to a running card with its channel's department hue", () => {
    const model = buildConsole({
      liveSessions: [session({ id: "s1" })],
      pending: [],
      shipped: [],
      channels,
      directory,
    });
    expect(model.columns.running).toHaveLength(1);
    const card = model.columns.running[0]!;
    expect(card.kind).toBe("running");
    expect(card.agentLabel).toBe("Scout");
    expect(card.hue).toBe(departmentColor("seo")); // 3px edge = department
    expect(card.elapsedMs).toBe(60_000);
    expect(card.costCents).toBe(84);
  });

  it("maps a pending approval to a waiting card carrying its request id (the gate is never bypassed)", () => {
    const model = buildConsole({
      liveSessions: [],
      pending: [approval({ id: "r1", amount: 4000 })],
      shipped: [],
      channels,
      directory,
    });
    expect(model.columns.waiting).toHaveLength(1);
    const card = model.columns.waiting[0]!;
    expect(card.kind).toBe("waiting");
    expect(card.requestId).toBe("r1");
    expect(card.amount).toBe(4000);
    expect(card.title).toBe("Send launch emails");
  });

  it("maps an executed approval to a shipped card", () => {
    const model = buildConsole({
      liveSessions: [],
      pending: [],
      shipped: [approval({ id: "r2", status: "executed" })],
      channels,
      directory,
    });
    expect(model.columns.shipped).toHaveLength(1);
    expect(model.columns.shipped[0]!.kind).toBe("shipped");
  });
});

describe("buildConsole — standup projects", () => {
  it("groups items into department-channel projects with per-status tallies", () => {
    const model = buildConsole({
      liveSessions: [session({ id: "s1" })],
      // Postmark's approval routes to the #email project via its department.
      pending: [approval({ id: "r1" })],
      shipped: [],
      channels,
      directory,
    });
    const seo = model.projects.find((p) => p.name === "seo")!;
    const email = model.projects.find((p) => p.name === "email")!;
    expect(seo.counts.running).toBe(1);
    expect(seo.needsYou).toBe(false);
    expect(email.counts.waiting).toBe(1);
    expect(email.needsYou).toBe(true); // a pending approval makes the lane need a human
  });

  it("only surfaces projects that have work (empty channels stay quiet)", () => {
    const model = buildConsole({
      liveSessions: [session({ id: "s1", channelId: "c-seo" })],
      pending: [],
      shipped: [],
      channels,
      directory,
    });
    expect(model.projects.map((p) => p.name)).toEqual(["seo"]);
  });

  it("renders every department channel as a lane when activated, even with zero work (#226)", () => {
    // An activated workspace (≥1 venture) must show its departments even before the first session spawns —
    // created-but-paused — so the console never collapses to an empty desk. Shared/DM rooms stay quiet.
    const model = buildConsole({
      liveSessions: [],
      pending: [],
      shipped: [],
      channels,
      directory,
      activated: true,
    });
    expect(model.projects.map((p) => p.name).sort()).toEqual(["email", "seo"]);
    expect(model.projects.every((p) => p.items.length === 0)).toBe(true);
  });

  it("never drops an item on a non-public/unknown channel — it lands in the trailing 'other' lane", () => {
    const model = buildConsole({
      liveSessions: [
        session({ id: "dm", channelId: "c-dm" }), // a DM channel (kind: dm)
        session({ id: "gone", channelId: "c-archived-or-unknown" }), // not in the channel list at all
      ],
      pending: [],
      shipped: [],
      channels,
      directory,
    });
    // Both still appear on the board…
    expect(model.columns.running).toHaveLength(2);
    // …and both are grouped into the single trailing "other" lane (nothing silently disappears).
    const other = model.projects.find((p) => p.name === "other")!;
    expect(other.items).toHaveLength(2);
    expect(model.projects.filter((p) => p.name === "other")).toHaveLength(1);
  });
});

describe("spinner + forecast", () => {
  it("the braille spinner wraps its frames", () => {
    expect(brailleFrame(0)).toBe(BRAILLE_FRAMES[0]);
    expect(brailleFrame(BRAILLE_FRAMES.length)).toBe(BRAILLE_FRAMES[0]);
    expect(brailleFrame(-1)).toBe(BRAILLE_FRAMES[BRAILLE_FRAMES.length - 1]);
  });

  it("spend forecast is on-track below 80% and at-risk over budget", () => {
    expect(spendForecast({ estimatedCostCents: 100, budgetCents: 1000, overBudget: false, utilization: 0.1 })).toEqual({
      fraction: 0.1,
      atRisk: false,
      hasCap: true,
    });
    expect(spendForecast({ estimatedCostCents: 900, budgetCents: 1000, overBudget: false, utilization: 0.9 }).atRisk).toBe(true);
    expect(spendForecast({ estimatedCostCents: 50, budgetCents: 0, overBudget: false, utilization: null })).toEqual({
      fraction: 0,
      atRisk: false,
      hasCap: false,
    });
  });
});

describe("buildConsole — deliverable cards are human, never raw (#302)", () => {
  const deliverable = (over: Partial<ApprovalRequestDto> & { id: string }): ApprovalRequestDto =>
    approval({
      requesterMemberId: "ag-scout",
      actionType: "agent.deliverable",
      summary: "Deliverable ready for review: Audit the homepage for SEO… fetch https://x.test",
      payload: {
        task: "Audit the homepage for SEO… fetch https://x.test",
        draft: "Found 3 quick wins\nMissing meta description on /pricing",
      },
      ...over,
    });

  it("renders a HUMAN title (the work, no boilerplate/URL) — not the raw prompt", () => {
    const model = buildConsole({
      liveSessions: [],
      pending: [deliverable({ id: "d1" })],
      shipped: [],
      channels,
      directory,
    });
    const card = model.columns.waiting[0]!;
    expect(card.title).toBe("Audit the homepage for SEO");
    expect(card.title).not.toMatch(/ready for review/i);
    expect(card.title).not.toMatch(/https?:\/\//);
  });

  it("never exposes the raw `agent.deliverable` type id as the card meta", () => {
    const model = buildConsole({
      liveSessions: [],
      pending: [deliverable({ id: "d1" })],
      shipped: [],
      channels,
      directory,
    });
    const card = model.columns.waiting[0]!;
    expect(card.meta).not.toContain("agent.deliverable");
    // A waiting deliverable carries a preview + a "what happens if I approve" consequence line.
    expect(card.preview).toBe("Found 3 quick wins");
    expect(card.consequence).toBeTruthy();
  });

  it("a Done deliverable reads as accepted — never 'ready for review'", () => {
    const model = buildConsole({
      liveSessions: [],
      pending: [],
      shipped: [deliverable({ id: "d2", status: "executed" })],
      channels,
      directory,
    });
    const card = model.columns.shipped[0]!;
    expect(card.meta).not.toMatch(/ready for review/i);
    expect(card.consequence).toBeUndefined();
  });

  it("filters internal/test deliverables out of the board entirely", () => {
    const model = buildConsole({
      liveSessions: [],
      pending: [
        deliverable({
          id: "d-internal",
          summary: "Deliverable ready for review: Reply with one sentence confirming you can run, then stop",
          payload: { task: "Reply with one sentence confirming you can run, then stop", draft: "ok" },
        }),
        deliverable({ id: "d-real" }),
      ],
      shipped: [],
      channels,
      directory,
    });
    expect(model.columns.waiting).toHaveLength(1);
    expect(model.columns.waiting[0]!.key).toBe("d-real");
  });

  it("humanises a non-deliverable action's meta too (no raw `external.send` id)", () => {
    const model = buildConsole({
      liveSessions: [],
      pending: [approval({ id: "r1", actionType: "external.send", summary: "Send launch emails" })],
      shipped: [],
      channels,
      directory,
    });
    const card = model.columns.waiting[0]!;
    expect(card.title).toBe("Send launch emails");
    expect(card.meta).not.toContain("external.send");
  });
});
