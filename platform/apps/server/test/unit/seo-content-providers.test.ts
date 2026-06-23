/**
 * Unit tests for the SEO content pipeline providers (#598): the deterministic FAKE registry produces stable,
 * gate-passing artifacts with no IO, and the real scaffolds are no-ops without a credential AND a transport.
 */

import { describe, it, expect } from "vitest";
import { GATE_POLICY_DEFAULTS } from "../../src/seo-content/caps.js";
import {
  evaluateKeywordGate,
  evaluateBriefGate,
  evaluateDraftGate,
  computeKeywordRelevance,
} from "../../src/seo-content/gates.js";
import {
  createFakeProviders,
  RealPublishProvider,
  RealIndexProvider,
  type PublishTransport,
  type IndexTransport,
} from "../../src/seo-content/providers.js";

const POLICY = GATE_POLICY_DEFAULTS;

describe("FAKE provider registry (#598)", () => {
  it("keyword research is deterministic and clears the keyword gate for an on-topic keyword", async () => {
    const p = createFakeProviders().keyword;
    const a = await p.research({ topic: "ai marketing automation", keyword: "ai marketing" });
    const b = await p.research({ topic: "ai marketing automation", keyword: "ai marketing" });
    expect(a).toEqual(b); // deterministic
    const relevance = computeKeywordRelevance(a.keyword, "ai marketing automation");
    expect(evaluateKeywordGate(a, relevance, POLICY).decision).toBe("allow");
  });

  it("an empty keyword yields zero volume (gate-blocking) — no accidental pass", async () => {
    const a = await createFakeProviders().keyword.research({ topic: "t", keyword: "  " });
    expect(a.monthlyVolume).toBe(0);
  });

  it("brief generation is deterministic and clears the brief gate", async () => {
    const p = createFakeProviders().brief;
    const a = await p.generate({ keyword: "ai marketing", topic: "marketing" });
    const b = await p.generate({ keyword: "ai marketing", topic: "marketing" });
    expect(a).toEqual(b);
    expect(a.primaryKeyword).toBe("ai marketing");
    expect(evaluateBriefGate(a, "ai marketing", POLICY).decision).toBe("allow");
  });

  it("draft generation is deterministic and clears the brand + fact gate", async () => {
    const providers = createFakeProviders();
    const brief = await providers.brief.generate({ keyword: "ai marketing", topic: "marketing" });
    const a = await providers.draft.generate({ brief });
    const b = await providers.draft.generate({ brief });
    expect(a).toEqual(b);
    expect(a.claims.every((c) => c.sourceUrl.length > 0)).toBe(true);
    expect(evaluateDraftGate(a, brief, POLICY).decision).toBe("allow");
  });

  it("publish + index are deterministic sandbox no-IO receipts (stable url / receipt id)", async () => {
    const providers = createFakeProviders();
    const pub = await providers.publish.publish({ runId: "r1", title: "T", body: "B", credential: null });
    expect(pub).toEqual(await providers.publish.publish({ runId: "r1", title: "T", body: "B", credential: "ignored" }));
    expect(pub.status).toBe("ok");
    expect(pub.url).toMatch(/^https:\/\/sandbox\.test\/posts\//);

    const idx = await providers.index.ping({ runId: "r1", url: pub.url ?? "", credential: null });
    expect(idx.status).toBe("ok");
    expect(idx.receiptId).toMatch(/^idx_/);
  });
});

describe("real provider scaffolds are inert without credential + transport (#598)", () => {
  it("publish with no credential is a recorded no-op", async () => {
    const out = await new RealPublishProvider().publish({ runId: "r", title: "t", body: "b", credential: null });
    expect(out).toEqual({ status: "failed", url: null, error: "no credentials" });
  });

  it("publish with a credential but no transport is a recorded no-op (never live-publishes)", async () => {
    const out = await new RealPublishProvider().publish({ runId: "r", title: "t", body: "b", credential: "tok" });
    expect(out).toEqual({ status: "failed", url: null, error: "no transport configured" });
  });

  it("publish with a credential AND a transport forwards once; a throwing transport is caught", async () => {
    const ok: PublishTransport = { publish: async () => ({ url: "https://live.test/p/1" }) };
    expect(await new RealPublishProvider(ok).publish({ runId: "r", title: "t", body: "b", credential: "tok" })).toEqual(
      { status: "ok", url: "https://live.test/p/1" },
    );
    const boom: PublishTransport = {
      publish: async () => {
        throw new Error("nope");
      },
    };
    expect(await new RealPublishProvider(boom).publish({ runId: "r", title: "t", body: "b", credential: "tok" })).toEqual(
      { status: "failed", url: null, error: "nope" },
    );
  });

  it("index ping mirrors the same no-op / forward / catch contract", async () => {
    expect(await new RealIndexProvider().ping({ runId: "r", url: "u", credential: null })).toEqual({
      status: "failed",
      receiptId: null,
      error: "no credentials",
    });
    expect(await new RealIndexProvider().ping({ runId: "r", url: "u", credential: "tok" })).toEqual({
      status: "failed",
      receiptId: null,
      error: "no transport configured",
    });
    const ok: IndexTransport = { ping: async () => ({ receiptId: "rcpt-1" }) };
    expect(await new RealIndexProvider(ok).ping({ runId: "r", url: "u", credential: "tok" })).toEqual({
      status: "ok",
      receiptId: "rcpt-1",
    });
  });
});
