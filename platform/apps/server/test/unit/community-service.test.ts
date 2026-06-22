/**
 * Unit tests for the community participation service (#597) over the in-memory store and a controllable provider.
 * Exercises the full contract — discover (dry run, disabled no-op) → fail-closed queue (spam refused) →
 * approval-gated post (never auto-posts) → disabled no-op, the error fallback, workspace (IDOR) scoping, and the
 * single-use post guard.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  CommunityParticipationService,
  CommunityGateError,
} from "../../src/community/service.js";
import { InMemoryParticipationStore } from "../../src/community/store.js";
import {
  createRealProviderRegistry,
  type ProviderRegistry,
} from "../../src/community/provider.js";
import { COMMUNITY_DEFAULTS, type CommunityCaps } from "../../src/community/caps.js";
import type { ProductContext } from "../../src/community/draft.js";
import type {
  CommunityPlatform,
  CommunityProvider,
  CommunityThread,
  FindThreadsInput,
  ProviderPostInput,
  ProviderPostResult,
} from "../../src/community/types.js";

const WID = "ws-1";
const OTHER_WID = "ws-2";
const APPROVAL = "approval-abc";
const T0 = new Date("2026-01-01T00:00:00.000Z");

const PRODUCT: ProductContext = {
  name: "ipop.ai",
  url: "https://ipop.ai",
  topics: ["ai", "marketing-automation", "growth"],
  disclosure: "(disclosure: I work on ipop.ai)",
};

/** A provider that records every call and returns scripted results; lets a test assert "never called". */
class SpyProvider implements CommunityProvider {
  postCalls: ProviderPostInput[] = [];
  findCalls: FindThreadsInput[] = [];
  constructor(
    public readonly platform: CommunityPlatform,
    private readonly postResult: ProviderPostResult | (() => ProviderPostResult) = {
      status: "posted",
      externalId: "ext-1",
    },
    private readonly threads: CommunityThread[] = [],
  ) {}
  async findThreads(input: FindThreadsInput): Promise<CommunityThread[]> {
    this.findCalls.push(input);
    return this.threads.filter((t) => t.platform === input.platform);
  }
  async post(input: ProviderPostInput): Promise<ProviderPostResult> {
    this.postCalls.push(input);
    return typeof this.postResult === "function" ? this.postResult() : this.postResult;
  }
}

function spyRegistry(make: (p: CommunityPlatform) => SpyProvider): ProviderRegistry {
  return { reddit: make("reddit"), slack: make("slack"), discord: make("discord") };
}

function thread(over: Partial<CommunityThread> = {}): CommunityThread {
  return {
    id: "t-1",
    platform: "reddit",
    communityRef: "r/saas",
    title: "How do you handle AI workflows?",
    body: "body (DATA)",
    url: null,
    ageHours: 4,
    replyCount: 1,
    topics: ["ai", "cooking"], // relevance 0.5 ⇒ relevant but below the product-mention threshold
    ...over,
  };
}

interface Built {
  service: CommunityParticipationService;
  store: InMemoryParticipationStore;
  providers: ProviderRegistry;
}

function build(opts: {
  enabled?: boolean;
  caps?: Partial<CommunityCaps>;
  providers?: ProviderRegistry;
  now?: () => Date;
} = {}): Built {
  const store = new InMemoryParticipationStore();
  const providers = opts.providers ?? spyRegistry((p) => new SpyProvider(p));
  const caps: CommunityCaps = {
    ...COMMUNITY_DEFAULTS,
    enabled: opts.enabled ?? true,
    ...opts.caps,
  };
  const service = new CommunityParticipationService({
    store,
    product: PRODUCT,
    providers,
    caps,
    now: opts.now ?? (() => T0),
  });
  return { service, store, providers };
}

describe("CommunityParticipationService (#597)", () => {
  let b: Built;
  beforeEach(() => {
    b = build();
  });

  it("discover is an inert no-op when the agent is disabled (no fetch)", async () => {
    const built = build({ enabled: false });
    const out = await built.service.discover({ workspaceId: WID, platform: "reddit", communities: ["r/saas"] });
    expect(out).toEqual([]);
    expect((built.providers.reddit as SpyProvider).findCalls).toHaveLength(0);
  });

  it("discover drafts + gates each found thread without persisting or posting", async () => {
    const built = build({
      providers: spyRegistry((p) => new SpyProvider(p, { status: "posted", externalId: "x" }, [thread()])),
    });
    const out = await built.service.discover({ workspaceId: WID, platform: "reddit", communities: ["r/saas"] });
    expect(out).toHaveLength(1);
    expect(out[0]?.gate.decision).toBe("allow");
    expect(out[0]?.draft.mentionsProduct).toBe(false);
    // nothing persisted, nothing posted
    expect(await built.service.list(WID)).toHaveLength(0);
    expect((built.providers.reddit as SpyProvider).postCalls).toHaveLength(0);
  });

  it("queue persists a gate-approved reply as `queued` and posts nothing", async () => {
    const rec = await b.service.queue({ workspaceId: WID, thread: thread() });
    expect(rec.status).toBe("queued");
    expect(rec.approvalRequestId).toBeNull();
    expect(rec.externalId).toBeNull();
    expect(rec.mentionsProduct).toBe(false);
    expect((b.providers.reddit as SpyProvider).postCalls).toHaveLength(0);
  });

  it("queue is FAIL-CLOSED: a reply the anti-spam gate blocks is refused and never persisted", async () => {
    // No topic overlap ⇒ relevance 0 ⇒ gate blocks (not_relevant).
    await expect(
      b.service.queue({ workspaceId: WID, thread: thread({ topics: ["cooking", "sports"] }) }),
    ).rejects.toBeInstanceOf(CommunityGateError);
    expect(await b.service.list(WID)).toHaveLength(0);
  });

  it("CommunityGateError carries the gate decision so the caller can explain the refusal", async () => {
    try {
      await b.service.queue({ workspaceId: WID, thread: thread({ ageHours: 999999 }) });
      throw new Error("expected a gate error");
    } catch (err) {
      expect(err).toBeInstanceOf(CommunityGateError);
      expect((err as CommunityGateError).gate.reasons.map((r) => r.code)).toContain("thread_too_old");
    }
  });

  it("post refuses without an approval id (never auto-posts)", async () => {
    const rec = await b.service.queue({ workspaceId: WID, thread: thread() });
    await expect(b.service.post(WID, rec.id, { approvalRequestId: "" })).rejects.toThrow(/approved item/);
    expect((b.providers.reddit as SpyProvider).postCalls).toHaveLength(0);
  });

  it("post records `posted` + external id via the provider once approved", async () => {
    const rec = await b.service.queue({ workspaceId: WID, thread: thread() });
    const out = await b.service.post(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("posted");
    expect(out.externalId).toBe("ext-1");
    expect(out.approvalRequestId).toBe(APPROVAL);
    expect((b.providers.reddit as SpyProvider).postCalls).toHaveLength(1);
  });

  it("forwards the user-supplied credential for the record's platform to the provider", async () => {
    const built = build({
      caps: { credentials: { ...COMMUNITY_DEFAULTS.credentials, reddit: "tok-9" } },
    });
    const rec = await built.service.queue({ workspaceId: WID, thread: thread() });
    await built.service.post(WID, rec.id, { approvalRequestId: APPROVAL });
    expect((built.providers.reddit as SpyProvider).postCalls[0]?.credential).toBe("tok-9");
  });

  it("disabled agent makes post an inert no-op: provider untouched, record stays queued", async () => {
    const built = build({ enabled: false });
    const rec = await built.service.queue({ workspaceId: WID, thread: thread() });
    const out = await built.service.post(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("queued");
    expect((built.providers.reddit as SpyProvider).postCalls).toHaveLength(0);
  });

  it("no-credentials real adapter is a no-op recorded as failed (no external id)", async () => {
    const built = build({ providers: createRealProviderRegistry() });
    const rec = await built.service.queue({ workspaceId: WID, thread: thread() });
    const out = await built.service.post(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("failed");
    expect(out.externalId).toBeNull();
    expect(out.error).toBe("no credentials");
  });

  it("error fallback: a throwing provider becomes a recorded failed outcome", async () => {
    const built = build({
      providers: spyRegistry(
        (p) =>
          new SpyProvider(p, () => {
            throw new Error("boom");
          }),
      ),
    });
    const rec = await built.service.queue({ workspaceId: WID, thread: thread() });
    const out = await built.service.post(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("failed");
    expect(out.error).toBe("boom");
  });

  it("a provider failure result is recorded as failed with the error", async () => {
    const built = build({
      providers: spyRegistry((p) => new SpyProvider(p, { status: "failed", externalId: null, error: "rejected" })),
    });
    const rec = await built.service.queue({ workspaceId: WID, thread: thread() });
    const out = await built.service.post(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("failed");
    expect(out.error).toBe("rejected");
  });

  it("post is single-use: a second post on a terminal record throws", async () => {
    const rec = await b.service.queue({ workspaceId: WID, thread: thread() });
    await b.service.post(WID, rec.id, { approvalRequestId: APPROVAL });
    await expect(b.service.post(WID, rec.id, { approvalRequestId: APPROVAL })).rejects.toThrow(/already posted/);
  });

  it("enforces workspace (IDOR) scoping on get/post", async () => {
    const rec = await b.service.queue({ workspaceId: WID, thread: thread() });
    expect(await b.service.get(OTHER_WID, rec.id)).toBeNull();
    await expect(
      b.service.post(OTHER_WID, rec.id, { approvalRequestId: APPROVAL }),
    ).rejects.toThrow(/no such participation record/);
  });

  it("lists a workspace's records newest first, filterable by status", async () => {
    const a = await b.service.queue({ workspaceId: WID, thread: thread({ id: "a", communityRef: "r/a" }) });
    await b.service.queue({ workspaceId: WID, thread: thread({ id: "b", communityRef: "r/b" }) });
    await b.service.post(WID, a.id, { approvalRequestId: APPROVAL });
    expect(await b.service.list(WID)).toHaveLength(2);
    const queued = await b.service.list(WID, "queued");
    expect(queued.map((r) => r.threadId)).toEqual(["b"]);
    const posted = await b.service.list(WID, "posted");
    expect(posted.map((r) => r.threadId)).toEqual(["a"]);
  });

  it("the anti-spam rate limit is enforced END-TO-END across queued+posted history", async () => {
    // Saturate the per-community window with posted replies, then the next queue must be refused.
    const built = build({ caps: { policy: { ...COMMUNITY_DEFAULTS.policy, maxRepliesPerWindow: 1, minHoursBetweenReplies: 0 } } });
    const first = await built.service.queue({ workspaceId: WID, thread: thread({ id: "t1" }) });
    await built.service.post(WID, first.id, { approvalRequestId: APPROVAL });
    // Same community, within the window ⇒ rate-limited.
    await expect(
      built.service.queue({ workspaceId: WID, thread: thread({ id: "t2" }) }),
    ).rejects.toBeInstanceOf(CommunityGateError);
  });
});
