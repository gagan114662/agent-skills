/**
 * Unit tests for the X agent providers (#596): the deterministic sandbox provider and the real adapter. Covers
 * sandbox determinism for publish/reverse and the no-op behavior of the real adapter when it lacks a credential
 * or a wired transport (so this change set never live-posts), plus the transport error path.
 */

import { describe, it, expect } from "vitest";
import {
  FakeXProvider,
  RealXAdapter,
  createFakeXProvider,
  createRealXProvider,
  stableHash,
  type XTransport,
} from "../../src/x-agent/provider.js";
import type { ProviderPublishInput, ProviderReverseInput } from "../../src/x-agent/types.js";

function pub(over: Partial<ProviderPublishInput> = {}): ProviderPublishInput {
  return {
    kind: "post",
    content: { text: "hello" },
    targetTweetId: null,
    scheduleAt: null,
    credential: null,
    ...over,
  };
}

function rev(over: Partial<ProviderReverseInput> = {}): ProviderReverseInput {
  return { kind: "reply", externalId: "ext-1", targetTweetId: "t-1", credential: null, ...over };
}

describe("stableHash", () => {
  it("is deterministic and order-sensitive", () => {
    expect(stableHash(["a", "b"])).toBe(stableHash(["a", "b"]));
    expect(stableHash(["a", "b"])).not.toBe(stableHash(["b", "a"]));
  });
});

describe("FakeXProvider", () => {
  const provider = new FakeXProvider();

  it("publishes with a stable, kind-prefixed fake external id (no network)", async () => {
    const a = await provider.publish(pub());
    const b = await provider.publish(pub());
    expect(a.status).toBe("published");
    expect(a.externalId).toMatch(/^fake_post_/);
    expect(a.externalId).toBe(b.externalId);
  });

  it("different content yields a different external id", async () => {
    const a = await provider.publish(pub({ content: { text: "one" } }));
    const b = await provider.publish(pub({ content: { text: "two" } }));
    expect(a.externalId).not.toBe(b.externalId);
  });

  it("hashes thread content too", async () => {
    const a = await provider.publish(pub({ kind: "thread", content: { tweets: ["1/2 a", "2/2 b"] } }));
    expect(a.status).toBe("published");
    expect(a.externalId).toMatch(/^fake_thread_/);
  });

  it("reverse always succeeds", async () => {
    expect(await provider.reverse(rev())).toEqual({ status: "reversed" });
  });

  it("createFakeXProvider returns a working sandbox provider", async () => {
    const out = await createFakeXProvider().publish(pub());
    expect(out.status).toBe("published");
  });
});

describe("RealXAdapter", () => {
  it("is a no-op without a credential (never live-posts)", async () => {
    const adapter = new RealXAdapter();
    expect(await adapter.publish(pub())).toEqual({ status: "failed", externalId: null, error: "no credentials" });
    expect(await adapter.reverse(rev())).toEqual({ status: "failed", error: "no credentials" });
  });

  it("with a credential but no transport is a no-op", async () => {
    const adapter = new RealXAdapter();
    const out = await adapter.publish(pub({ credential: "tok" }));
    expect(out).toEqual({ status: "failed", externalId: null, error: "no transport configured" });
    const rout = await adapter.reverse(rev({ credential: "tok" }));
    expect(rout).toEqual({ status: "failed", error: "no transport configured" });
  });

  it("forwards to a wired transport and returns its external id", async () => {
    const transport: XTransport = {
      async send() {
        return { externalId: "real-123" };
      },
      async undo() {
        /* no-op */
      },
    };
    const adapter = createRealXProvider(transport);
    const out = await adapter.publish(pub({ credential: "tok" }));
    expect(out).toEqual({ status: "published", externalId: "real-123" });
    expect(await adapter.reverse(rev({ credential: "tok" }))).toEqual({ status: "reversed" });
  });

  it("a throwing transport becomes a failed result, not an unhandled rejection", async () => {
    const transport: XTransport = {
      async send() {
        throw new Error("boom");
      },
      async undo() {
        throw new Error("undo-boom");
      },
    };
    const adapter = new RealXAdapter(transport);
    expect(await adapter.publish(pub({ credential: "tok" }))).toEqual({
      status: "failed",
      externalId: null,
      error: "boom",
    });
    expect(await adapter.reverse(rev({ credential: "tok" }))).toEqual({ status: "failed", error: "undo-boom" });
  });
});
