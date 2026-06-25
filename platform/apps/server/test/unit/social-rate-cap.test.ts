import { describe, expect, it } from "vitest";
import { decideSocialRateCap } from "../../src/social/rate-cap.js";
import type { SocialPostRecord, SocialPostResultRecord } from "../../src/social/store.js";

const post: SocialPostRecord = {
  id: "post-1",
  workspaceId: "ws-1",
  body: "hello",
  networks: ["x"],
  scheduledAt: null,
  status: "draft",
  approvalRequestId: null,
  aggregatorRef: null,
  createdAt: "2026-06-18T00:00:00.000Z",
};

function receipt(over: Partial<SocialPostResultRecord>): SocialPostResultRecord {
  return {
    id: "res-1",
    workspaceId: "ws-1",
    postId: "post-0",
    network: "x",
    status: "published",
    externalId: "x_1",
    permalink: "https://mock.social.local/x/x_1",
    error: null,
    recordedAt: "2026-06-18T11:59:00.000Z",
    ...over,
  };
}

describe("social/rate-cap", () => {
  it("allows a request inside workspace, network, and warmup caps", () => {
    const decision = decideSocialRateCap({
      networks: ["x"],
      posts: [post],
      recentReceipts: [],
      now: new Date("2026-06-18T12:00:00.000Z"),
      caps: { warmupStartCap: 1 },
    });
    expect(decision.allowed).toBe(true);
  });

  it("blocks a workspace-wide burst across networks", () => {
    const decision = decideSocialRateCap({
      networks: ["x", "linkedin"],
      posts: [post],
      recentReceipts: [receipt({ id: "res-a", network: "instagram" })],
      now: new Date("2026-06-18T12:00:00.000Z"),
      caps: { workspaceCap: 2, warmupDays: 0 },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("workspace social cap exceeded");
  });

  it("blocks a per-network burst", () => {
    const decision = decideSocialRateCap({
      networks: ["x"],
      posts: [post],
      recentReceipts: [receipt({ network: "x" })],
      now: new Date("2026-06-18T12:00:00.000Z"),
      caps: { networkCap: 1, warmupDays: 0 },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("x social cap exceeded");
  });

  it("ramps fresh workspaces through warmup", () => {
    const decision = decideSocialRateCap({
      networks: ["x", "linkedin"],
      posts: [post],
      recentReceipts: [],
      now: new Date("2026-06-18T12:00:00.000Z"),
      caps: { warmupDays: 7, warmupStartCap: 1, warmupDailyIncrement: 1 },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("social warmup cap exceeded");
  });
});
