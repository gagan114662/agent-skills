/**
 * Unit tests for the SEO content pipeline service (#598) over the in-memory store and controllable providers.
 * Exercises the full contract — staged advance (gated at each step), the brand/fact gate catching junk drafts,
 * fail-closed blocking + RESUME (after fixing the input, and across a fresh service instance), approval-gated
 * publish/index (never auto-runs), the disabled no-op, the provider-error fallback, single-run-no-double-publish,
 * and workspace (IDOR) scoping.
 */

import { describe, it, expect } from "vitest";
import {
  SeoContentPipelineService,
  type AdvanceOptions,
} from "../../src/seo-content/service.js";
import { InMemoryPipelineStore } from "../../src/seo-content/store.js";
import { createFakeProviders, type PipelineProviders } from "../../src/seo-content/providers.js";
import { SEO_CONTENT_DEFAULTS, type SeoContentCaps } from "../../src/seo-content/caps.js";
import type {
  ContentDraft,
  IndexPingResult,
  KeywordMetrics,
  PublishResult,
} from "../../src/seo-content/types.js";

const WID = "ws-1";
const OTHER_WID = "ws-2";
const APPROVAL = "approval-abc";
const T0 = new Date("2026-01-01T00:00:00.000Z");
const TOPIC = "ai marketing automation for growth teams";

/** Spy keyword provider: metrics are a function of the keyword so a test can drive a block then a pass. */
class SpyKeywordProvider {
  calls: { topic: string; keyword: string }[] = [];
  constructor(private readonly fn: (kw: string) => KeywordMetrics) {}
  async research(input: { topic: string; keyword: string }): Promise<KeywordMetrics> {
    this.calls.push(input);
    return this.fn(input.keyword);
  }
}

/** Spy publish provider with a scripted result and a call counter (to prove "published exactly once"). */
class SpyPublishProvider {
  calls = 0;
  constructor(private readonly result: PublishResult | (() => PublishResult)) {}
  async publish(): Promise<PublishResult> {
    this.calls += 1;
    return typeof this.result === "function" ? this.result() : this.result;
  }
}

class SpyIndexProvider {
  calls = 0;
  constructor(private readonly result: IndexPingResult | (() => IndexPingResult)) {}
  async ping(): Promise<IndexPingResult> {
    this.calls += 1;
    return typeof this.result === "function" ? this.result() : this.result;
  }
}

interface BuildOpts {
  enabled?: boolean;
  caps?: Partial<SeoContentCaps>;
  providers?: Partial<PipelineProviders>;
  store?: InMemoryPipelineStore;
}

function build(opts: BuildOpts = {}) {
  const store = opts.store ?? new InMemoryPipelineStore();
  const providers: PipelineProviders = { ...createFakeProviders(), ...opts.providers };
  const caps: SeoContentCaps = { ...SEO_CONTENT_DEFAULTS, enabled: opts.enabled ?? true, ...opts.caps };
  const service = new SeoContentPipelineService({ store, providers, caps, now: () => T0 });
  return { service, store, providers };
}

/** Advance a run all the way through the two gate-only stages after `keyword`, returning the run at `publish`. */
async function toPublishStage(service: SeoContentPipelineService, runId: string): Promise<void> {
  await service.advance(WID, runId); // keyword → brief
  await service.advance(WID, runId); // brief → draft
  await service.advance(WID, runId); // draft → publish
}

describe("SeoContentPipelineService (#598)", () => {
  it("create requires a topic and starts a run at the keyword stage", async () => {
    const { service } = build();
    await expect(service.create({ workspaceId: WID, topic: "   " })).rejects.toThrow(/topic is required/);
    const run = await service.create({ workspaceId: WID, topic: TOPIC });
    expect(run.stage).toBe("keyword");
    expect(run.status).toBe("active");
    expect(run.keyword).toBeNull();
  });

  it("advances the full pipeline end-to-end with the FAKE providers, gating each step", async () => {
    const { service } = build();
    const run = await service.create({ workspaceId: WID, topic: TOPIC });

    const afterKeyword = await service.advance(WID, run.id, { keyword: "ai marketing" });
    expect(afterKeyword.stage).toBe("brief");
    expect(afterKeyword.keyword?.keyword).toBe("ai marketing");

    const afterBrief = await service.advance(WID, run.id);
    expect(afterBrief.stage).toBe("draft");
    expect(afterBrief.brief?.primaryKeyword).toBe("ai marketing");

    const afterDraft = await service.advance(WID, run.id);
    expect(afterDraft.stage).toBe("publish");
    expect(afterDraft.draft).not.toBeNull();

    const afterPublish = await service.advance(WID, run.id, { approvalRequestId: APPROVAL });
    expect(afterPublish.stage).toBe("index_ping");
    expect(afterPublish.publishedUrl).toMatch(/^https:\/\/sandbox\.test\/posts\//);
    expect(afterPublish.publishApprovalId).toBe(APPROVAL);

    const done = await service.advance(WID, run.id, { approvalRequestId: "approval-idx" });
    expect(done.stage).toBe("done");
    expect(done.status).toBe("completed");
    expect(done.indexReceiptId).toMatch(/^idx_/);
    expect(done.indexApprovalId).toBe("approval-idx");
    expect(done.blockedReasons).toEqual([]);
  });

  it("disabled agent makes advance an inert no-op: provider untouched, run unchanged", async () => {
    const spyKeyword = new SpyKeywordProvider(() => {
      throw new Error("should not be called when disabled");
    });
    const { service } = build({ enabled: false, providers: { keyword: spyKeyword } });
    const run = await service.create({ workspaceId: WID, topic: TOPIC });
    const out = await service.advance(WID, run.id);
    expect(out.stage).toBe("keyword");
    expect(out.status).toBe("active");
    expect(spyKeyword.calls).toHaveLength(0);
  });

  it("is FAIL-CLOSED at the keyword gate, then RESUMES once a better keyword is supplied", async () => {
    const spyKeyword = new SpyKeywordProvider((kw) => ({
      keyword: kw,
      monthlyVolume: kw.includes("good") ? 5000 : 5, // "good" keyword clears the volume floor
      difficulty: 20,
      intent: "commercial",
    }));
    const { service } = build({ providers: { keyword: spyKeyword } });
    const run = await service.create({ workspaceId: WID, topic: "good ai growth content" });

    const blocked = await service.advance(WID, run.id, { keyword: "bad" });
    expect(blocked.stage).toBe("keyword");
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedReasons.map((r) => r.code)).toContain("volume_too_low");

    // Resume from the SAME run with a corrected keyword — the block is not terminal.
    const resumed = await service.advance(WID, run.id, { keyword: "good ai" });
    expect(resumed.stage).toBe("brief");
    expect(resumed.status).toBe("active");
    expect(resumed.blockedReasons).toEqual([]);
  });

  it("catches a junk draft at the brand/fact gate and never reaches publish", async () => {
    // A draft with an unsourced claim — the issue's headline failure mode.
    const junkDraft: ContentDraft = {
      title: "Junk",
      body: `ai marketing ${"word ".repeat(400)}`.trim(),
      wordCount: 401,
      claims: [{ text: "unbacked assertion", sourceUrl: "" }],
    };
    const { service } = build({ providers: { draft: { generate: async () => junkDraft } } });
    const run = await service.create({ workspaceId: WID, topic: TOPIC });
    await service.advance(WID, run.id, { keyword: "ai marketing" }); // → brief
    await service.advance(WID, run.id); // → draft
    const blocked = await service.advance(WID, run.id); // draft gate runs
    expect(blocked.stage).toBe("draft");
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedReasons.map((r) => r.code)).toContain("draft_unsourced_claim");
    expect(blocked.draft).toBeNull(); // the junk draft is not stored
  });

  it("a run blocked at the draft gate RESUMES across a fresh service instance over the same store", async () => {
    const store = new InMemoryPipelineStore();
    const bad = build({ store, providers: { draft: { generate: async () => ({ title: "", body: "x", wordCount: 1, claims: [] }) } } });
    const run = await bad.service.create({ workspaceId: WID, topic: TOPIC });
    await bad.service.advance(WID, run.id, { keyword: "ai marketing" });
    await bad.service.advance(WID, run.id);
    const blocked = await bad.service.advance(WID, run.id);
    expect(blocked.status).toBe("blocked");

    // A brand-new service (good draft provider) over the SAME store picks the run up mid-pipeline.
    const good = build({ store }); // default FAKE draft provider passes
    const resumed = await good.service.advance(WID, run.id);
    expect(resumed.stage).toBe("publish");
    expect(resumed.draft).not.toBeNull();
  });

  it("publish and index_ping REFUSE without an approval id (never auto-publish / auto-ping)", async () => {
    const spyPublish = new SpyPublishProvider({ status: "ok", url: "https://x.test/p" });
    const { service } = build({ providers: { publish: spyPublish } });
    const run = await service.create({ workspaceId: WID, topic: TOPIC });
    await toPublishStage(service, run.id);

    await expect(service.advance(WID, run.id)).rejects.toThrow(/publish requires an approved item/);
    await expect(service.advance(WID, run.id, { approvalRequestId: "  " })).rejects.toThrow(/approved item/);
    expect(spyPublish.calls).toBe(0); // provider never touched without approval
  });

  it("records a publish failure as blocked-and-resumable (no double publish on success)", async () => {
    let attempt = 0;
    const spyPublish = new SpyPublishProvider(() =>
      ++attempt === 1 ? { status: "failed", url: null, error: "cms 500" } : { status: "ok", url: "https://x.test/p2" },
    );
    const { service } = build({ providers: { publish: spyPublish } });
    const run = await service.create({ workspaceId: WID, topic: TOPIC });
    await toPublishStage(service, run.id);

    const blocked = await service.advance(WID, run.id, { approvalRequestId: APPROVAL });
    expect(blocked.stage).toBe("publish");
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedReasons.map((r) => r.code)).toContain("publish_failed");
    expect(blocked.publishedUrl).toBeNull();
    expect(blocked.publishApprovalId).toBe(APPROVAL); // the authorizing approval is recorded on the attempt

    // Retry publishes; the index stage then runs against the now-published URL, so publish runs exactly twice total.
    const published = await service.advance(WID, run.id, { approvalRequestId: APPROVAL });
    expect(published.stage).toBe("index_ping");
    expect(published.publishedUrl).toBe("https://x.test/p2");
    await service.advance(WID, run.id, { approvalRequestId: "idx" });
    expect(spyPublish.calls).toBe(2);
  });

  it("error fallback: a throwing publish provider becomes a recorded blocked outcome", async () => {
    const spyPublish = new SpyPublishProvider(() => {
      throw new Error("boom");
    });
    const { service } = build({ providers: { publish: spyPublish } });
    const run = await service.create({ workspaceId: WID, topic: TOPIC });
    await toPublishStage(service, run.id);
    const blocked = await service.advance(WID, run.id, { approvalRequestId: APPROVAL });
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedReasons[0]?.code).toBe("publish_failed");
    expect(blocked.blockedReasons[0]?.message).toBe("boom");
  });

  it("an index-ping failure blocks at index_ping with the published URL intact", async () => {
    const spyIndex = new SpyIndexProvider({ status: "failed", receiptId: null, error: "quota" });
    const { service } = build({ providers: { index: spyIndex } });
    const run = await service.create({ workspaceId: WID, topic: TOPIC });
    await toPublishStage(service, run.id);
    const published = await service.advance(WID, run.id, { approvalRequestId: APPROVAL });
    expect(published.publishedUrl).not.toBeNull();
    const blocked = await service.advance(WID, run.id, { approvalRequestId: "idx" });
    expect(blocked.stage).toBe("index_ping");
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedReasons.map((r) => r.code)).toContain("index_ping_failed");
    expect(blocked.publishedUrl).toBe(published.publishedUrl); // earlier work is preserved
  });

  it("forwards the user-supplied publish/index credentials to the providers", async () => {
    let seen: string | null = "unset";
    const spyPublish = {
      publish: async (i: { credential: string | null }) => {
        seen = i.credential;
        return { status: "ok" as const, url: "https://x.test/p" };
      },
    };
    const { service } = build({
      caps: { credentials: { publish: "pub-tok", index: "idx-tok" } },
      providers: { publish: spyPublish },
    });
    const run = await service.create({ workspaceId: WID, topic: TOPIC });
    await toPublishStage(service, run.id);
    await service.advance(WID, run.id, { approvalRequestId: APPROVAL });
    expect(seen).toBe("pub-tok");
  });

  it("throws on a terminal run and enforces workspace (IDOR) scoping", async () => {
    const { service } = build();
    const run = await service.create({ workspaceId: WID, topic: TOPIC });
    // IDOR: another workspace cannot see or advance this run.
    expect(await service.get(OTHER_WID, run.id)).toBeNull();
    await expect(service.advance(OTHER_WID, run.id)).rejects.toThrow(/no such run/);

    // Run to completion, then a further advance is refused.
    await toPublishStage(service, run.id);
    await service.advance(WID, run.id, { approvalRequestId: APPROVAL });
    await service.advance(WID, run.id, { approvalRequestId: "idx" });
    await expect(service.advance(WID, run.id, { approvalRequestId: "x" })).rejects.toThrow(/already completed/);
  });

  it("lists a workspace's runs newest first, filterable by status", async () => {
    const { service } = build();
    const a = await service.create({ workspaceId: WID, topic: TOPIC });
    await service.create({ workspaceId: WID, topic: "second topic about ai" });
    // Block `a` at the keyword gate via an empty keyword.
    const opts: AdvanceOptions = { keyword: "   " };
    await service.advance(WID, a.id, opts);

    expect(await service.list(WID)).toHaveLength(2);
    const blocked = await service.list(WID, "blocked");
    expect(blocked.map((r) => r.id)).toEqual([a.id]);
    expect(await service.list(OTHER_WID)).toHaveLength(0);
  });
});
