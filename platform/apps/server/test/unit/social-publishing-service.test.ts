/**
 * Unit tests for the social publishing service (#742) over the in-memory store and a controllable provider.
 * Exercises the full contract — queue (no post) → approval-gated publish → schedule / publish-now / error —
 * plus the disabled no-op, the no-credentials no-op (via the real registry), workspace (IDOR) scoping, and the
 * single-use publish guard.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SocialPublishingService,
  SocialPublishingError,
} from "../../src/social-publishing/service.js";
import { InMemoryPublishStore } from "../../src/social-publishing/store.js";
import {
  createRealProviderRegistry,
  type ProviderRegistry,
} from "../../src/social-publishing/provider.js";
import { SOCIAL_PUBLISHING_DEFAULTS, type SocialPublishingCaps } from "../../src/social-publishing/caps.js";
import {
  SOCIAL_PLATFORMS,
  type ProviderPublishInput,
  type ProviderPublishResult,
  type PublishProvider,
  type SocialPlatform,
} from "../../src/social-publishing/types.js";

const WID = "ws-1";
const OTHER_WID = "ws-2";
const APPROVAL = "approval-abc";
const T0 = new Date("2026-01-01T00:00:00.000Z");

/** A provider that records every call and returns a scripted result; lets a test assert "never called". */
class SpyProvider implements PublishProvider {
  calls: ProviderPublishInput[] = [];
  constructor(
    public readonly platform: SocialPlatform,
    private readonly result: ProviderPublishResult | (() => ProviderPublishResult) = {
      status: "published",
      externalId: "ext-1",
    },
  ) {}
  async publish(input: ProviderPublishInput): Promise<ProviderPublishResult> {
    this.calls.push(input);
    return typeof this.result === "function" ? this.result() : this.result;
  }
}

function spyRegistry(make: (p: SocialPlatform) => SpyProvider): ProviderRegistry {
  return {
    tiktok: make("tiktok"),
    instagram_reels: make("instagram_reels"),
    youtube_shorts: make("youtube_shorts"),
  };
}

interface Built {
  service: SocialPublishingService;
  store: InMemoryPublishStore;
  providers: ProviderRegistry;
}

function build(opts: {
  enabled?: boolean;
  caps?: Partial<SocialPublishingCaps>;
  providers?: ProviderRegistry;
  now?: () => Date;
} = {}): Built {
  const store = new InMemoryPublishStore();
  const providers = opts.providers ?? spyRegistry((p) => new SpyProvider(p));
  const caps: SocialPublishingCaps = {
    ...SOCIAL_PUBLISHING_DEFAULTS,
    enabled: opts.enabled ?? true,
    ...opts.caps,
  };
  const service = new SocialPublishingService({
    store,
    providers,
    caps,
    now: opts.now ?? (() => T0),
  });
  return { service, store, providers };
}

async function queueOne(b: Built, over: Partial<Parameters<SocialPublishingService["queue"]>[0]> = {}) {
  return b.service.queue({
    workspaceId: WID,
    platform: "tiktok",
    asset: { ref: "vid-1" },
    caption: "ship it",
    ...over,
  });
}

describe("SocialPublishingService (#742)", () => {
  let b: Built;
  beforeEach(() => {
    b = build();
  });

  it("queue creates a queued record and posts nothing", async () => {
    const rec = await queueOne(b);
    expect(rec.status).toBe("queued");
    expect(rec.externalId).toBeNull();
    expect(rec.approvalRequestId).toBeNull();
    const spy = b.providers.tiktok as SpyProvider;
    expect(spy.calls).toHaveLength(0);
  });

  it("queue rejects an unknown platform and a missing asset ref", async () => {
    await expect(
      b.service.queue({
        workspaceId: WID,
        // @ts-expect-error intentionally invalid platform
        platform: "twitter",
        asset: { ref: "x" },
        caption: "c",
      }),
    ).rejects.toBeInstanceOf(SocialPublishingError);
    await expect(queueOne(b, { asset: { ref: "  " } })).rejects.toBeInstanceOf(SocialPublishingError);
  });

  it("publish refuses without an approval id (never auto-posts)", async () => {
    const rec = await queueOne(b);
    await expect(
      b.service.publish(WID, rec.id, { approvalRequestId: "" }),
    ).rejects.toThrow(/approved item/);
    const spy = b.providers.tiktok as SpyProvider;
    expect(spy.calls).toHaveLength(0);
  });

  it("publish-now records published + external id via the provider (per platform)", async () => {
    for (const platform of SOCIAL_PLATFORMS) {
      const built = build({
        providers: spyRegistry((p) => new SpyProvider(p, { status: "published", externalId: `ext-${p}` })),
      });
      const rec = await built.service.queue({
        workspaceId: WID,
        platform,
        asset: { ref: `vid-${platform}` },
        caption: "go",
      });
      const out = await built.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
      expect(out.status).toBe("published");
      expect(out.externalId).toBe(`ext-${platform}`);
      expect(out.approvalRequestId).toBe(APPROVAL);
      expect((built.providers[platform] as SpyProvider).calls).toHaveLength(1);
    }
  });

  it("forwards the user-supplied credential for the record's platform to the provider", async () => {
    const built = build({ caps: { credentials: { ...SOCIAL_PUBLISHING_DEFAULTS.credentials, tiktok: "tok-9" } } });
    const rec = await queueOne(built);
    await built.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
    const spy = built.providers.tiktok as SpyProvider;
    expect(spy.calls[0]?.credential).toBe("tok-9");
  });

  it("schedule-in-future records scheduled WITHOUT calling the provider", async () => {
    const future = new Date(T0.getTime() + 60_000);
    const rec = await queueOne(b, { scheduleAt: future });
    const out = await b.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("scheduled");
    expect(out.externalId).toBeNull();
    expect(out.approvalRequestId).toBe(APPROVAL);
    expect((b.providers.tiktok as SpyProvider).calls).toHaveLength(0);
  });

  it("a past scheduleAt publishes now (not deferred)", async () => {
    const past = new Date(T0.getTime() - 60_000);
    const rec = await queueOne(b, { scheduleAt: past });
    const out = await b.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("published");
    expect((b.providers.tiktok as SpyProvider).calls).toHaveLength(1);
  });

  it("disabled connector is an inert no-op: provider untouched, record stays queued", async () => {
    const built = build({ enabled: false });
    const rec = await queueOne(built);
    const out = await built.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("queued");
    expect(out.externalId).toBeNull();
    expect((built.providers.tiktok as SpyProvider).calls).toHaveLength(0);
  });

  it("no-credentials real adapter is a no-op recorded as failed (no external id)", async () => {
    // Real registry, no transport, no credential ⇒ provider returns failed without posting.
    const built = build({ providers: createRealProviderRegistry() });
    const rec = await queueOne(built);
    const out = await built.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
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
    const rec = await queueOne(built);
    const out = await built.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("failed");
    expect(out.externalId).toBeNull();
    expect(out.error).toBe("boom");
  });

  it("a provider failure result is recorded as failed with the error", async () => {
    const built = build({
      providers: spyRegistry((p) => new SpyProvider(p, { status: "failed", externalId: null, error: "rejected" })),
    });
    const rec = await queueOne(built);
    const out = await built.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("failed");
    expect(out.error).toBe("rejected");
  });

  it("publish is single-use: a second publish on a terminal record throws", async () => {
    const rec = await queueOne(b);
    await b.service.publish(WID, rec.id, { approvalRequestId: APPROVAL });
    await expect(
      b.service.publish(WID, rec.id, { approvalRequestId: APPROVAL }),
    ).rejects.toThrow(/already published/);
  });

  it("enforces workspace (IDOR) scoping on get/publish", async () => {
    const rec = await queueOne(b);
    expect(await b.service.get(OTHER_WID, rec.id)).toBeNull();
    await expect(
      b.service.publish(OTHER_WID, rec.id, { approvalRequestId: APPROVAL }),
    ).rejects.toThrow(/no such publish record/);
  });

  it("lists a workspace's records newest first, filterable by status", async () => {
    const a = await queueOne(b, { asset: { ref: "a" } });
    await queueOne(b, { asset: { ref: "b" } });
    await b.service.publish(WID, a.id, { approvalRequestId: APPROVAL });
    const all = await b.service.list(WID);
    expect(all).toHaveLength(2);
    const queued = await b.service.list(WID, "queued");
    expect(queued.map((r) => r.asset.ref)).toEqual(["b"]);
    const published = await b.service.list(WID, "published");
    expect(published.map((r) => r.asset.ref)).toEqual(["a"]);
  });
});
