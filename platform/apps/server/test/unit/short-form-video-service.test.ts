import { describe, it, expect } from "vitest";
import { SHORTFORM_VIDEO_DEFAULTS } from "../../src/short-form-video/config.js";
import { ShortFormVideoService } from "../../src/short-form-video/service.js";
import { InMemoryVideoJobStore } from "../../src/short-form-video/store.js";
import { FakeVideoProvider, type VideoProvider } from "../../src/short-form-video/provider.js";
import type { RenderSpec, RenderedVideo, VideoRequest } from "../../src/short-form-video/types.js";

/**
 * The #740 service lifecycle: the four terminal outcomes — disabled / missing_brief / script_only / rendered
 * — plus determinism, persistence, and the #3 IDOR boundary. Deterministic via an injected clock + id factory
 * and the in-memory store (no DB).
 */
const CLOCK = () => new Date(1_700_000_000_000);

function makeIds() {
  let i = 0;
  return () => `job-${i++}`;
}

function request(overrides: Partial<VideoRequest> = {}): VideoRequest {
  return {
    workspaceId: "ws-1",
    requestedByMemberId: "member-1",
    topic: "Why founders waste 10 hours a week on marketing",
    brief: {
      audience: "early-stage founders",
      positioning: "An AI marketing department that ships real work",
      voice: "warm, direct",
      brandClaims: ["Human-approved before anything ships"],
    },
    ...overrides,
  };
}

function makeService(
  opts: { enabled?: boolean; provider?: VideoProvider; store?: InMemoryVideoJobStore } = {},
) {
  const store = opts.store ?? new InMemoryVideoJobStore();
  const service = new ShortFormVideoService({
    config: { ...SHORTFORM_VIDEO_DEFAULTS, enabled: opts.enabled ?? true },
    provider: opts.provider ?? new FakeVideoProvider(),
    store,
    now: CLOCK,
    newId: makeIds(),
  });
  return { service, store };
}

/** A provider that always rejects — used to drive the graceful-fallback path. */
class FailingProvider implements VideoProvider {
  readonly id = "failing";
  readonly live = false;
  async render(_spec: RenderSpec): Promise<RenderedVideo> {
    throw new Error("render backend unavailable");
  }
}

describe("ShortFormVideoService (#740)", () => {
  it("HAPPY PATH: renders a brief-grounded video and persists a `rendered` job", async () => {
    const { service, store } = makeService();
    const result = await service.generate(request());

    expect(result.status).toBe("rendered");
    expect(result.script).not.toBeNull();
    expect(result.video).not.toBeNull();
    expect(result.video?.provider).toBe("fake");
    expect(result.video?.url).toContain("ws-1");
    expect(result.reason).toBeNull();

    // The attempt was persisted and is readable back, workspace-scoped.
    expect(result.job).not.toBeNull();
    const persisted = await store.get("ws-1", result.job!.id);
    expect(persisted?.status).toBe("rendered");
    expect(persisted?.video?.assetId).toBe(result.video?.assetId);
    expect(persisted?.createdAt).toEqual(CLOCK());
  });

  it("is deterministic — the same request yields the same asset id", async () => {
    const a = await makeService().service.generate(request());
    const b = await makeService().service.generate(request());
    expect(a.video?.assetId).toBe(b.video?.assetId);
  });

  it("DISABLED (default): generates nothing and persists nothing, never touching the provider", async () => {
    const provider = new FakeVideoProvider();
    let calls = 0;
    const counting: VideoProvider = {
      id: provider.id,
      live: provider.live,
      render: (spec) => {
        calls++;
        return provider.render(spec);
      },
    };
    const { service, store } = makeService({ enabled: false, provider: counting });

    const result = await service.generate(request());
    expect(result.status).toBe("disabled");
    expect(result.job).toBeNull();
    expect(result.script).toBeNull();
    expect(result.video).toBeNull();
    expect(calls).toBe(0);
    expect(await store.listByWorkspace("ws-1")).toEqual([]);
  });

  it("MISSING BRIEF: refuses to generate, records the refusal, and never calls the provider", async () => {
    let calls = 0;
    const provider: VideoProvider = {
      id: "spy",
      live: false,
      render: async () => {
        calls++;
        throw new Error("should not be called");
      },
    };
    const { service, store } = makeService({ provider });

    const result = await service.generate(
      request({ brief: { audience: "founders", positioning: "", voice: "", brandClaims: [] } }),
    );

    expect(result.status).toBe("missing_brief");
    expect(result.script).toBeNull();
    expect(result.video).toBeNull();
    expect(result.reason).toContain("brief");
    expect(calls).toBe(0);
    // The refusal is auditable.
    const jobs = await store.listByWorkspace("ws-1");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("missing_brief");
  });

  it("PROVIDER ERROR FALLBACK: keeps the script as `script_only` and records the error", async () => {
    const { service, store } = makeService({ provider: new FailingProvider() });
    const result = await service.generate(request());

    expect(result.status).toBe("script_only");
    // The agent's work is NOT lost — the script survives the provider failure.
    expect(result.script).not.toBeNull();
    expect(result.script?.scenes.length).toBeGreaterThan(0);
    expect(result.video).toBeNull();
    expect(result.reason).toContain("failing");
    expect(result.reason).toContain("render backend unavailable");

    const persisted = await store.get("ws-1", result.job!.id);
    expect(persisted?.status).toBe("script_only");
    expect(persisted?.script).not.toBeNull();
    expect(persisted?.video).toBeNull();
    expect(persisted?.error).toContain("render backend unavailable");
  });

  it("is workspace-scoped — one workspace never reads another's jobs (#3 IDOR)", async () => {
    const { service, store } = makeService();
    const mine = await service.generate(request({ workspaceId: "ws-1" }));
    await service.generate(request({ workspaceId: "ws-2" }));

    // ws-2 cannot read ws-1's job by id, and only sees its own in a list.
    expect(await store.get("ws-2", mine.job!.id)).toBeNull();
    expect(await service.get("ws-1", mine.job!.id)).not.toBeNull();
    const ws2 = await service.list("ws-2");
    expect(ws2).toHaveLength(1);
    expect(ws2[0]?.workspaceId).toBe("ws-2");
  });
});
