/**
 * Unit tests for the X agent service (#596) over the in-memory store and a controllable provider. Exercises the
 * full contract — draft (no post) → approval-gated publish → schedule / publish-now / error → reversible
 * engagement — plus the disabled no-op, the no-credentials real-adapter no-op, workspace (IDOR) scoping, and
 * the single-use publish/reverse guards.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { XAgentService, XAgentError } from "../../src/x-agent/service.js";
import { InMemoryXActionStore } from "../../src/x-agent/store.js";
import { createRealXProvider } from "../../src/x-agent/provider.js";
import { X_AGENT_DEFAULTS, type XAgentCaps } from "../../src/x-agent/caps.js";
import type {
  ProviderPublishInput,
  ProviderPublishResult,
  ProviderReverseInput,
  ProviderReverseResult,
  XProvider,
} from "../../src/x-agent/types.js";

const WID = "ws-1";
const OTHER_WID = "ws-2";
const APPROVAL = "approval-abc";
const T0 = new Date("2026-01-01T00:00:00.000Z");

/** A provider that records every call and returns scripted results; lets a test assert "never called". */
class SpyProvider implements XProvider {
  publishCalls: ProviderPublishInput[] = [];
  reverseCalls: ProviderReverseInput[] = [];
  constructor(
    private readonly publishResult: ProviderPublishResult | (() => ProviderPublishResult) = {
      status: "published",
      externalId: "ext-1",
    },
    private readonly reverseResult: ProviderReverseResult | (() => ProviderReverseResult) = {
      status: "reversed",
    },
  ) {}
  async publish(input: ProviderPublishInput): Promise<ProviderPublishResult> {
    this.publishCalls.push(input);
    return typeof this.publishResult === "function" ? this.publishResult() : this.publishResult;
  }
  async reverse(input: ProviderReverseInput): Promise<ProviderReverseResult> {
    this.reverseCalls.push(input);
    return typeof this.reverseResult === "function" ? this.reverseResult() : this.reverseResult;
  }
}

interface Built {
  service: XAgentService;
  store: InMemoryXActionStore;
  provider: SpyProvider;
}

function build(opts: {
  enabled?: boolean;
  caps?: Partial<XAgentCaps>;
  provider?: SpyProvider | XProvider;
  now?: () => Date;
} = {}): Built {
  const store = new InMemoryXActionStore();
  const provider = opts.provider ?? new SpyProvider();
  const caps: XAgentCaps = { ...X_AGENT_DEFAULTS, enabled: opts.enabled ?? true, ...opts.caps };
  const service = new XAgentService({ store, provider, caps, now: opts.now ?? (() => T0) });
  return { service, store, provider: provider as SpyProvider };
}

async function draftPost(b: Built) {
  return b.service.draftPost(WID, { topic: "We shipped scheduled posting" });
}

describe("XAgentService (#596)", () => {
  let b: Built;
  beforeEach(() => {
    b = build();
  });

  it("draftPost creates a draft record and posts nothing", async () => {
    const rec = await draftPost(b);
    expect(rec.status).toBe("draft");
    expect(rec.kind).toBe("post");
    expect(rec.content.text).toContain("We shipped scheduled posting");
    expect(rec.approvalRequestId).toBeNull();
    expect(rec.externalId).toBeNull();
    expect(b.provider.publishCalls).toHaveLength(0);
  });

  it("draftThread and draftReply create the right kinds without posting", async () => {
    const thread = await b.service.draftThread(WID, { topic: "hook", points: ["one", "two"] });
    expect(thread.kind).toBe("thread");
    expect(thread.content.tweets).toHaveLength(3);

    const reply = await b.service.draftReply(WID, {
      signal: { tweetId: "999", authorHandle: "@x", text: "untrusted" },
      angle: "great point",
    });
    expect(reply.kind).toBe("reply");
    expect(reply.targetTweetId).toBe("999");
    expect(reply.content.text).toContain("@x");
    expect(b.provider.publishCalls).toHaveLength(0);
  });

  it("queueEngagement records a bare like/repost with a target and no content", async () => {
    const like = await b.service.queueEngagement({ workspaceId: WID, kind: "like", targetTweetId: "555" });
    expect(like.kind).toBe("like");
    expect(like.targetTweetId).toBe("555");
    expect(like.content.text).toBeUndefined();
    await expect(
      b.service.queueEngagement({ workspaceId: WID, kind: "repost", targetTweetId: "  " }),
    ).rejects.toBeInstanceOf(XAgentError);
  });

  it("publish refuses without an approval id (never auto-posts)", async () => {
    const rec = await draftPost(b);
    await expect(b.service.publish(WID, rec.id, { approvalRequestId: "" })).rejects.toThrow(/approved item/);
    expect(b.provider.publishCalls).toHaveLength(0);
  });

  it("publish-now records published + external id via the provider", async () => {
    const rec = await draftPost(b);
    const out = await b.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("published");
    expect(out.externalId).toBe("ext-1");
    expect(out.approvalRequestId).toBe(APPROVAL);
    expect(b.provider.publishCalls).toHaveLength(1);
  });

  it("forwards the user-supplied credential to the provider", async () => {
    const built = build({ caps: { credential: "tok-9" } });
    const rec = await draftPost(built);
    await built.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(built.provider.publishCalls[0]?.credential).toBe("tok-9");
  });

  it("schedule-in-future records scheduled WITHOUT calling the provider", async () => {
    const future = new Date(T0.getTime() + 60_000);
    const rec = await b.service.draftPost(WID, { topic: "later" }, future);
    const out = await b.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("scheduled");
    expect(out.externalId).toBeNull();
    expect(out.approvalRequestId).toBe(APPROVAL);
    expect(b.provider.publishCalls).toHaveLength(0);
  });

  it("a past scheduleAt publishes now (not deferred)", async () => {
    const past = new Date(T0.getTime() - 60_000);
    const rec = await b.service.draftPost(WID, { topic: "overdue" }, past);
    const out = await b.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("published");
    expect(b.provider.publishCalls).toHaveLength(1);
  });

  it("disabled agent is an inert no-op: provider untouched, record stays draft", async () => {
    const built = build({ enabled: false });
    const rec = await draftPost(built);
    const out = await built.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("draft");
    expect(built.provider.publishCalls).toHaveLength(0);
  });

  it("no-credentials real adapter is a no-op recorded as failed (no external id)", async () => {
    const built = build({ provider: createRealXProvider() });
    const rec = await draftPost(built);
    const out = await built.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("failed");
    expect(out.externalId).toBeNull();
    expect(out.error).toBe("no credentials");
  });

  it("error fallback: a throwing provider becomes a recorded failed outcome", async () => {
    const built = build({
      provider: new SpyProvider(() => {
        throw new Error("boom");
      }),
    });
    const rec = await draftPost(built);
    const out = await built.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("failed");
    expect(out.error).toBe("boom");
  });

  it("a provider failure result is recorded as failed with the error", async () => {
    const built = build({ provider: new SpyProvider({ status: "failed", externalId: null, error: "rejected" }) });
    const rec = await draftPost(built);
    const out = await built.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("failed");
    expect(out.error).toBe("rejected");
  });

  it("publish is single-use: a second publish on a terminal record throws", async () => {
    const rec = await draftPost(b);
    await b.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
    await expect(b.service.publish(WID, rec.id, { approvalRequestId: APPROVAL })).rejects.toThrow(
      /already published/,
    );
  });

  describe("reverse (logged + reversible engagement)", () => {
    async function published(built: Built) {
      const rec = await built.service.queueEngagement({ workspaceId: WID, kind: "like", targetTweetId: "t-9" });
      return built.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
    }

    it("reverses a published engagement, recording who approved it and when", async () => {
      const pub = await published(b);
      const out = await b.service.reverse(WID, pub.id, { approvalRequestId: "rev-1" });
      expect(out.status).toBe("reversed");
      expect(out.reverseApprovalRequestId).toBe("rev-1");
      expect(out.reversedAt).toEqual(T0);
      expect(b.provider.reverseCalls).toHaveLength(1);
      expect(b.provider.reverseCalls[0]?.externalId).toBe("ext-1");
    });

    it("reverse refuses without an approval id (also approval-gated)", async () => {
      const pub = await published(b);
      await expect(b.service.reverse(WID, pub.id, { approvalRequestId: "" })).rejects.toThrow(/approved item/);
      expect(b.provider.reverseCalls).toHaveLength(0);
    });

    it("cannot reverse a draft (only published actions are reversible)", async () => {
      const rec = await draftPost(b);
      await expect(b.service.reverse(WID, rec.id, { approvalRequestId: "rev-1" })).rejects.toThrow(
        /only a published action/,
      );
    });

    it("a failing reverse leaves the record published and surfaces the error", async () => {
      const built = build({ provider: new SpyProvider({ status: "published", externalId: "ext-1" }, { status: "failed", error: "nope" }) });
      const pub = await published(built);
      await expect(built.service.reverse(WID, pub.id, { approvalRequestId: "rev-1" })).rejects.toThrow(/nope/);
      const after = await built.service.get(WID, pub.id);
      expect(after?.status).toBe("published");
    });

    it("reverse is single-use: a second reverse throws", async () => {
      const pub = await published(b);
      await b.service.reverse(WID, pub.id, { approvalRequestId: "rev-1" });
      await expect(b.service.reverse(WID, pub.id, { approvalRequestId: "rev-2" })).rejects.toThrow(
        /only a published action/,
      );
    });

    it("disabled agent: reverse is an inert no-op (record stays published)", async () => {
      // A record can only reach `published` while enabled, so seed one directly through the store, then assert
      // the disabled service refuses to touch the provider on reverse and leaves the record published.
      const disabled = build({ enabled: false });
      const rec = await disabled.store.create(
        { workspaceId: WID, kind: "like", content: {}, targetTweetId: "t", scheduleAt: null },
        T0,
      );
      await disabled.store.applyPublishOutcome(WID, rec.id, {
        status: "published",
        approvalRequestId: APPROVAL,
        externalId: "ext-x",
        error: null,
        updatedAt: T0,
      });
      const out = await disabled.service.reverse(WID, rec.id, { approvalRequestId: "rev-1" });
      expect(out.status).toBe("published");
      expect(disabled.provider.reverseCalls).toHaveLength(0);
    });
  });

  it("enforces workspace (IDOR) scoping on get/publish/reverse", async () => {
    const rec = await draftPost(b);
    expect(await b.service.get(OTHER_WID, rec.id)).toBeNull();
    await expect(b.service.publish(OTHER_WID, rec.id, { approvalRequestId: APPROVAL })).rejects.toThrow(
      /no such action/,
    );
    await expect(b.service.reverse(OTHER_WID, rec.id, { approvalRequestId: APPROVAL })).rejects.toThrow(
      /no such action/,
    );
  });

  it("lists a workspace's records newest first, filterable by status", async () => {
    const first = await b.service.draftPost(WID, { topic: "first" });
    await b.service.draftPost(WID, { topic: "second" });
    await b.service.publish(WID, first.id, { approvalRequestId: APPROVAL });
    const all = await b.service.list(WID);
    expect(all).toHaveLength(2);
    const drafts = await b.service.list(WID, "draft");
    expect(drafts.map((r) => r.content.text?.includes("second"))).toEqual([true]);
    const publishedList = await b.service.list(WID, "published");
    expect(publishedList).toHaveLength(1);
  });

  it("exposes resolved policy and isEngagement helper", () => {
    expect(b.service.policy.enabled).toBe(true);
    expect(b.service.isEngagement("reply")).toBe(true);
    expect(b.service.isEngagement("post")).toBe(false);
  });
});
