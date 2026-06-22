/**
 * Unit tests for the social publishing providers (#742): the deterministic sandbox adapter and the three real
 * adapters. Covers per-platform adapter shape, sandbox determinism, and the no-op behavior of a real adapter
 * when it lacks a credential or a wired transport (so this change set never live-posts).
 */

import { describe, it, expect } from "vitest";
import {
  FakePublishProvider,
  TikTokAdapter,
  InstagramReelsAdapter,
  YouTubeShortsAdapter,
  createFakeProviderRegistry,
  createRealProviderRegistry,
  isSocialPlatform,
  type PublishTransport,
} from "../../src/social-publishing/provider.js";
import { SOCIAL_PLATFORMS, type ProviderPublishInput } from "../../src/social-publishing/types.js";

function input(over: Partial<ProviderPublishInput> = {}): ProviderPublishInput {
  return {
    platform: "tiktok",
    asset: { ref: "asset-1" },
    caption: "hello",
    scheduleAt: null,
    credential: null,
    ...over,
  };
}

describe("social-publishing providers (#742)", () => {
  it("each real adapter carries its own platform (adapter shape)", () => {
    expect(new TikTokAdapter().platform).toBe("tiktok");
    expect(new InstagramReelsAdapter().platform).toBe("instagram_reels");
    expect(new YouTubeShortsAdapter().platform).toBe("youtube_shorts");
  });

  it("the default registry has a sandbox provider for every platform", () => {
    const registry = createFakeProviderRegistry();
    for (const platform of SOCIAL_PLATFORMS) {
      expect(registry[platform]).toBeInstanceOf(FakePublishProvider);
      expect(registry[platform].platform).toBe(platform);
    }
  });

  it("the sandbox provider publishes deterministically with a stable external id", async () => {
    const provider = new FakePublishProvider("tiktok");
    const a = await provider.publish(input({ platform: "tiktok", asset: { ref: "vid-9" } }));
    const b = await provider.publish(input({ platform: "tiktok", asset: { ref: "vid-9" } }));
    expect(a.status).toBe("published");
    expect(a.externalId).toBeTruthy();
    expect(a.externalId).toBe(b.externalId); // deterministic
    expect(a.externalId).toContain("tiktok");
  });

  it("the sandbox external id changes with the input (no collisions across assets)", async () => {
    const provider = new FakePublishProvider("youtube_shorts");
    const a = await provider.publish(input({ platform: "youtube_shorts", asset: { ref: "one" } }));
    const b = await provider.publish(input({ platform: "youtube_shorts", asset: { ref: "two" } }));
    expect(a.externalId).not.toBe(b.externalId);
  });

  it("a real adapter is a no-op without a credential (never an OAuth attempt)", async () => {
    const res = await new TikTokAdapter().publish(input({ credential: null }));
    expect(res.status).toBe("failed");
    expect(res.externalId).toBeNull();
    expect(res.error).toBe("no credentials");
  });

  it("a real adapter is a no-op with a credential but no transport wired (cannot live-post)", async () => {
    const res = await new InstagramReelsAdapter().publish(
      input({ platform: "instagram_reels", credential: "user-token" }),
    );
    expect(res.status).toBe("failed");
    expect(res.externalId).toBeNull();
    expect(res.error).toBe("no transport configured");
  });

  it("a real adapter forwards to an injected transport when credential + transport are present", async () => {
    const seen: ProviderPublishInput[] = [];
    const transport: PublishTransport = {
      async send(i) {
        seen.push(i);
        return { externalId: "yt-real-123" };
      },
    };
    const registry = createRealProviderRegistry(transport);
    const res = await registry.youtube_shorts.publish(
      input({ platform: "youtube_shorts", credential: "tok" }),
    );
    expect(res.status).toBe("published");
    expect(res.externalId).toBe("yt-real-123");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.credential).toBe("tok");
  });

  it("a real adapter maps a throwing transport to a failed result (error fallback)", async () => {
    const transport: PublishTransport = {
      async send() {
        throw new Error("network down");
      },
    };
    const res = await new TikTokAdapter(transport).publish(input({ credential: "tok" }));
    expect(res.status).toBe("failed");
    expect(res.externalId).toBeNull();
    expect(res.error).toBe("network down");
  });

  it("isSocialPlatform guards unknown routing keys", () => {
    expect(isSocialPlatform("tiktok")).toBe(true);
    expect(isSocialPlatform("twitter")).toBe(false);
  });
});
