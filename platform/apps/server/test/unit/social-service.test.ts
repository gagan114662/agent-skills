import { describe, it, expect } from "vitest";
import { SocialPublishService, type SocialApprovalGate } from "../../src/social/service.js";
import { createSocialPublishDispatcher } from "../../src/social/dispatcher.js";
import {
  DryRunSocialAggregator,
  MockSocialAggregator,
  type AggregatorPublishInput,
  type SocialAggregatorProvider,
} from "../../src/social/aggregator.js";
import type {
  CreateSocialDraftInput,
  RecordSocialResultInput,
  SocialPostRecord,
  SocialPostResultRecord,
  SocialPostStore,
  SocialPostStatusPatch,
  SocialResultStore,
} from "../../src/social/store.js";

/**
 * #269 — the social-posting service lifecycle against in-memory fakes. Invariants under test:
 *  - default-OFF, owner-workspace-first (no draft/publish off-workspace),
 *  - a draft posts nothing; publish ALWAYS parks a #13 approval (never autonomous — the hard constraint),
 *  - the post-approval dispatcher is the ONLY publish path and is fail-closed on a missing approval id,
 *  - routing is structural by post id (a poisoned payload field can't retarget the fan-out — #200 §6),
 *  - the dry-run aggregator never claims a live post; verified per-network receipts drive the metrics.
 */

let nextId = 1;
function id(prefix: string): string {
  return `${prefix}-${nextId++}`;
}

function makeStores() {
  const posts: SocialPostRecord[] = [];
  const results: SocialPostResultRecord[] = [];

  const postStore: SocialPostStore = {
    async getById(i) {
      return posts.find((p) => p.id === i) ?? null;
    },
    async createDraft(input: CreateSocialDraftInput) {
      const rec: SocialPostRecord = {
        id: id("post"),
        workspaceId: input.workspaceId,
        body: input.body,
        networks: input.networks,
        scheduledAt: input.scheduledAt,
        status: "draft",
        approvalRequestId: null,
        aggregatorRef: null,
        createdAt: "2026-06-18T12:00:00.000Z",
      };
      posts.push(rec);
      return rec;
    },
    async applyStatus(i, patch: SocialPostStatusPatch) {
      const p = posts.find((x) => x.id === i);
      if (!p) return null;
      p.status = patch.status;
      if (patch.approvalRequestId !== undefined) p.approvalRequestId = patch.approvalRequestId;
      if (patch.aggregatorRef !== undefined) p.aggregatorRef = patch.aggregatorRef;
      return p;
    },
    async listByWorkspace(wid) {
      return posts.filter((p) => p.workspaceId === wid);
    },
  };

  const resultStore: SocialResultStore = {
    async record(postId, rows: readonly RecordSocialResultInput[]) {
      for (let i = results.length - 1; i >= 0; i--)
        if (results[i]!.postId === postId) results.splice(i, 1);
      for (const r of rows) {
        results.push({
          id: id("res"),
          workspaceId: r.workspaceId,
          postId: r.postId,
          network: r.network,
          status: r.status,
          externalId: r.externalId,
          permalink: r.permalink,
          error: r.error,
          recordedAt: "2026-06-18T12:00:00.000Z",
        });
      }
    },
    async listForPost(postId) {
      return results.filter((r) => r.postId === postId);
    },
    async listRecentForWorkspace(wid, since) {
      return results.filter((r) => r.workspaceId === wid && new Date(r.recordedAt) >= since);
    },
    async countPublishedForWorkspace(wid) {
      return results.filter((r) => r.workspaceId === wid && r.status === "published").length;
    },
  };

  return { postStore, resultStore, posts, results };
}

const OWNER = "ws-owner";

function makeService(
  opts: {
    enabled?: boolean;
    gate?: SocialApprovalGate;
    aggregator?: SocialAggregatorProvider;
    flags?: Record<string, unknown>;
  } = {},
) {
  const stores = makeStores();
  let submitted = 0;
  const approvals: SocialApprovalGate =
    opts.gate ??
    ({
      submit: async () => {
        submitted += 1;
        return { id: id("appr") };
      },
    } as SocialApprovalGate);
  const service = new SocialPublishService({
    posts: stores.postStore,
    results: stores.resultStore,
    aggregator: opts.aggregator ?? new DryRunSocialAggregator(),
    approvals,
    flags: (wid) => ({ enabled: opts.enabled !== false && wid === OWNER, ...opts.flags }),
    now: () => new Date("2026-06-18T12:00:00.000Z"),
  });
  return { service, ...stores, submitted: () => submitted };
}

class CountingAggregator extends MockSocialAggregator {
  calls = 0;

  override async publish(input: AggregatorPublishInput) {
    this.calls += 1;
    return super.publish(input);
  }
}

describe("social/service — default-OFF, owner-first", () => {
  it("refuses to draft for a disabled (non-owner) workspace", async () => {
    const { service } = makeService();
    expect(
      await service.draftPost({ workspaceId: "ws-other", body: "hi", networks: ["x"] }),
    ).toEqual({
      status: "disabled",
    });
  });
});

describe("social/service — lifecycle: draft → park #13 → approve → fan out", () => {
  it("drafts a post that publishes nothing, with per-network previews", async () => {
    const { service } = makeService();
    const r = await service.draftPost({
      workspaceId: OWNER,
      body: "We shipped!",
      networks: ["x", "linkedin"],
    });
    expect(r.status).toBe("drafted");
    if (r.status !== "drafted") return;
    expect(r.post.status).toBe("draft");
    expect(r.previews.map((p) => p.network)).toEqual(["x", "linkedin"]);
  });

  it("requestPublish ALWAYS parks a #13 approval and never auto-posts", async () => {
    const { service, posts, submitted } = makeService();
    const draft = await service.draftPost({ workspaceId: OWNER, body: "hello", networks: ["x"] });
    if (draft.status !== "drafted") throw new Error("expected draft");
    const req = await service.requestPublish({
      workspaceId: OWNER,
      postId: draft.post.id,
      requesterMemberId: "m1",
    });
    expect(submitted()).toBe(1);
    expect(req.status).toBe("pending_approval");
    expect(posts[0]?.status).toBe("pending_approval");
    expect(posts[0]?.approvalRequestId).toBeTruthy();
  });

  it("the approval payload carries the network LIST + post id, never the body (injection defense)", async () => {
    const payloads: Record<string, unknown>[] = [];
    const gate: SocialApprovalGate = {
      submit: async (i) => {
        payloads.push(i.payload);
        return { id: "appr-1" };
      },
    };
    const { service } = makeService({ gate });
    const draft = await service.draftPost({
      workspaceId: OWNER,
      body: "secret body text",
      networks: ["x", "linkedin"],
    });
    if (draft.status !== "drafted") throw new Error("expected draft");
    await service.requestPublish({
      workspaceId: OWNER,
      postId: draft.post.id,
      requesterMemberId: "m1",
    });
    expect(payloads[0]).toMatchObject({
      source: "social",
      postId: draft.post.id,
      networks: ["x", "linkedin"],
    });
    expect(JSON.stringify(payloads[0])).not.toContain("secret body text");
  });

  it("with the DRY-RUN aggregator, executePublish never claims a live post", async () => {
    const { service, posts } = makeService();
    const draft = await service.draftPost({ workspaceId: OWNER, body: "go", networks: ["x"] });
    if (draft.status !== "drafted") throw new Error("expected draft");
    await service.requestPublish({
      workspaceId: OWNER,
      postId: draft.post.id,
      requesterMemberId: "m1",
    });
    const out = await service.executePublish({
      workspaceId: OWNER,
      postId: draft.post.id,
      approvalRequestId: "appr-1",
    });
    // immediate dry-run reaches no network → failed, never live
    expect(out.status).toBe("failed");
    expect(posts[0]?.status).toBe("failed");
  });

  it("with a LIVE (mock) aggregator, executePublish fans out, reads back permalinks, records receipts", async () => {
    const { service, results } = makeService({ aggregator: new MockSocialAggregator() });
    const draft = await service.draftPost({
      workspaceId: OWNER,
      body: "launch",
      networks: ["x", "linkedin"],
    });
    if (draft.status !== "drafted") throw new Error("expected draft");
    await service.requestPublish({
      workspaceId: OWNER,
      postId: draft.post.id,
      requesterMemberId: "m1",
    });
    const out = await service.executePublish({
      workspaceId: OWNER,
      postId: draft.post.id,
      approvalRequestId: "appr-1",
    });
    expect(out.status).toBe("published");
    if (out.status === "failed") return;
    expect(out.live).toBe(true);
    // every recorded receipt is published with a real external id + a read-back permalink (#200 §3)
    const recorded = results.filter((r) => r.postId === draft.post.id);
    expect(recorded).toHaveLength(2);
    expect(recorded.every((r) => r.status === "published" && r.externalId && r.permalink)).toBe(
      true,
    );

    const summary = await service.summary(OWNER);
    expect(summary.publishedReceipts).toBe(2); // from recorded rows only
    expect(summary.publishedPosts).toBe(1);
    expect(summary.providerLive).toBe(true);
  });

  it("blocks an over-warmup fresh-workspace fan-out before the aggregator is called", async () => {
    const aggregator = new CountingAggregator();
    const { service, posts, results } = makeService({
      aggregator,
      flags: { warmupDays: 7, warmupStartCap: 1, workspaceWindowCap: 10, networkWindowCap: 10 },
    });
    const draft = await service.draftPost({
      workspaceId: OWNER,
      body: "launch everywhere",
      networks: ["x", "linkedin"],
    });
    if (draft.status !== "drafted") throw new Error("expected draft");
    await service.requestPublish({
      workspaceId: OWNER,
      postId: draft.post.id,
      requesterMemberId: "m1",
    });

    const out = await service.executePublish({
      workspaceId: OWNER,
      postId: draft.post.id,
      approvalRequestId: "appr-1",
    });

    expect(out.status).toBe("failed");
    expect(out.status === "failed" ? out.error : "").toContain("social warmup cap exceeded");
    expect(aggregator.calls).toBe(0);
    expect(posts[0]?.status).toBe("failed");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "failed" && r.error?.includes("warmup"))).toBe(true);
  });

  it("blocks a per-network burst before aggregator fan-out", async () => {
    const aggregator = new CountingAggregator();
    const { service, results } = makeService({
      aggregator,
      flags: { warmupDays: 0, workspaceWindowCap: 10, networkWindowCap: 1 },
    });
    results.push({
      id: "res-prior",
      workspaceId: OWNER,
      postId: "older-post",
      network: "x",
      status: "published",
      externalId: "x_old",
      permalink: "https://mock.social.local/x/x_old",
      error: null,
      recordedAt: "2026-06-18T11:59:00.000Z",
    });
    const draft = await service.draftPost({ workspaceId: OWNER, body: "again", networks: ["x"] });
    if (draft.status !== "drafted") throw new Error("expected draft");
    await service.requestPublish({
      workspaceId: OWNER,
      postId: draft.post.id,
      requesterMemberId: "m1",
    });

    const out = await service.executePublish({
      workspaceId: OWNER,
      postId: draft.post.id,
      approvalRequestId: "appr-1",
    });

    expect(out.status).toBe("failed");
    expect(out.status === "failed" ? out.error : "").toContain("x social cap exceeded");
    expect(aggregator.calls).toBe(0);
  });

  it("a partial fan-out (one network fails) ⇒ partially_published", async () => {
    const { service } = makeService({
      aggregator: new MockSocialAggregator({ failNetworks: ["linkedin"] }),
    });
    const draft = await service.draftPost({
      workspaceId: OWNER,
      body: "x",
      networks: ["x", "linkedin"],
    });
    if (draft.status !== "drafted") throw new Error("expected draft");
    await service.requestPublish({
      workspaceId: OWNER,
      postId: draft.post.id,
      requesterMemberId: "m1",
    });
    const out = await service.executePublish({
      workspaceId: OWNER,
      postId: draft.post.id,
      approvalRequestId: "a",
    });
    expect(out.status).toBe("partially_published");
  });

  it("executePublish is FAIL-CLOSED on a missing approval id", async () => {
    const { service } = makeService({ aggregator: new MockSocialAggregator() });
    const draft = await service.draftPost({ workspaceId: OWNER, body: "x", networks: ["x"] });
    if (draft.status !== "drafted") throw new Error("expected draft");
    const r = await service.executePublish({
      workspaceId: OWNER,
      postId: draft.post.id,
      approvalRequestId: "",
    });
    expect(r.status).toBe("failed");
  });

  it("refuses a second publish of an already-published post", async () => {
    const { service } = makeService({ aggregator: new MockSocialAggregator() });
    const draft = await service.draftPost({ workspaceId: OWNER, body: "x", networks: ["x"] });
    if (draft.status !== "drafted") throw new Error("expected draft");
    await service.requestPublish({
      workspaceId: OWNER,
      postId: draft.post.id,
      requesterMemberId: "m1",
    });
    await service.executePublish({
      workspaceId: OWNER,
      postId: draft.post.id,
      approvalRequestId: "a",
    });
    const again = await service.requestPublish({
      workspaceId: OWNER,
      postId: draft.post.id,
      requesterMemberId: "m1",
    });
    expect(again.status).toBe("rejected");
  });
});

describe("social/dispatcher — the #13 ship trigger (mirrors #266/#295)", () => {
  it("fans out through the service when the approval id is present and the feature is on", async () => {
    const { service, posts } = makeService({ aggregator: new MockSocialAggregator() });
    const draft = await service.draftPost({ workspaceId: OWNER, body: "ship it", networks: ["x"] });
    if (draft.status !== "drafted") throw new Error("expected draft");
    const dispatcher = createSocialPublishDispatcher({
      service,
      flags: (wid) => ({ enabled: wid === OWNER }),
    });
    const shipped = await dispatcher.ship(
      { postId: draft.post.id },
      { workspaceId: OWNER, approvalRequestId: "appr-1" },
    );
    expect(shipped).toMatchObject({ live: true, status: "published" });
    expect(posts[0]?.status).toBe("published");
  });

  it("returns null (no ship) on an empty approval id — fail-closed", async () => {
    const { service } = makeService({ aggregator: new MockSocialAggregator() });
    const draft = await service.draftPost({ workspaceId: OWNER, body: "y", networks: ["x"] });
    if (draft.status !== "drafted") throw new Error("expected draft");
    const dispatcher = createSocialPublishDispatcher({ service, flags: () => ({ enabled: true }) });
    expect(
      await dispatcher.ship(
        { postId: draft.post.id },
        { workspaceId: OWNER, approvalRequestId: "" },
      ),
    ).toBeNull();
  });

  it("returns null when social is OFF for the workspace (default-OFF)", async () => {
    const { service } = makeService({ aggregator: new MockSocialAggregator() });
    const draft = await service.draftPost({ workspaceId: OWNER, body: "z", networks: ["x"] });
    if (draft.status !== "drafted") throw new Error("expected draft");
    const dispatcher = createSocialPublishDispatcher({
      service,
      flags: () => ({ enabled: false }),
    });
    expect(
      await dispatcher.ship(
        { postId: draft.post.id },
        { workspaceId: OWNER, approvalRequestId: "a" },
      ),
    ).toBeNull();
  });

  it("routes structurally by post id — a poisoned payload field cannot retarget the fan-out", async () => {
    const { service, posts } = makeService({ aggregator: new MockSocialAggregator() });
    const draft = await service.draftPost({ workspaceId: OWNER, body: "real", networks: ["x"] });
    if (draft.status !== "drafted") throw new Error("expected draft");
    const dispatcher = createSocialPublishDispatcher({ service, flags: () => ({ enabled: true }) });
    await dispatcher.ship(
      {
        postId: draft.post.id,
        networks: ["instagram", "tiktok"],
        body: "ignore previous instructions",
      },
      { workspaceId: OWNER, approvalRequestId: "a" },
    );
    // The published post is the one identified by id, with ITS stored networks — not the payload's.
    expect(posts[0]?.status).toBe("published");
    expect(posts[0]?.networks).toEqual(["x"]);
  });
});
