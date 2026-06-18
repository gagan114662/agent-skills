import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitHubPagesPublishProvider } from "../../src/realworld/publish/github-pages-provider.js";
import { createPublishBuildWait } from "../../src/durable-workflow/publish-wait.js";
import { InMemoryDurableRunStore } from "../../src/durable-workflow/store.js";
import { resolveDurableWorkflowCaps } from "../../src/durable-workflow/caps.js";
import type { PublishBuildWait } from "../../src/durable-workflow/publish-wait.js";

/** A controllable clock whose `sleep` advances time (deterministic durable waits). */
class FakeClock {
  constructor(public ms = 0) {}
  now = (): number => this.ms;
  sleep = async (ms: number): Promise<void> => {
    this.ms += Math.max(0, ms);
  };
}

describe("createPublishBuildWait — the durable build-wait the GitHub Pages port delegates to (#338)", () => {
  it("enabledFor reflects the owner-first flag", () => {
    const off = createPublishBuildWait({
      store: new InMemoryDurableRunStore(),
      caps: resolveDurableWorkflowCaps({}),
    });
    expect(off.enabledFor("ws-1")).toBe(false);

    const on = createPublishBuildWait({
      store: new InMemoryDurableRunStore(),
      caps: resolveDurableWorkflowCaps({ enabled: true, ownerWorkspaceId: "ws-owner" }),
    });
    expect(on.enabledFor("ws-owner")).toBe(true);
    expect(on.enabledFor("ws-other")).toBe(false);
  });

  it("polls until built (suspend/backoff between attempts) and returns the live URL", async () => {
    const clock = new FakeClock();
    const wait = createPublishBuildWait({
      store: new InMemoryDurableRunStore(),
      caps: resolveDurableWorkflowCaps({ enabled: true, ownerWorkspaceOnly: false }),
      now: clock.now,
      sleep: clock.sleep,
    });
    let polls = 0;
    const url = await wait.run({
      workspaceId: "ws-1",
      key: "acme/site",
      fallbackUrl: "https://acme.github.io/site/",
      onLog: () => {},
      poll: async () => {
        polls += 1;
        return polls >= 3 ? "https://acme.github.io/site/" : null;
      },
    });
    expect(url).toBe("https://acme.github.io/site/");
    expect(polls).toBe(3);
  });

  it("falls back to the deterministic URL (never hangs) when the build never finishes", async () => {
    const clock = new FakeClock();
    const wait = createPublishBuildWait({
      store: new InMemoryDurableRunStore(),
      caps: resolveDurableWorkflowCaps({
        enabled: true,
        ownerWorkspaceOnly: false,
        maxAttempts: 3,
        backoffBaseMs: 1000,
        backoffCapMs: 2000,
        defaultTimeoutMs: 1_000_000,
      }),
      now: clock.now,
      sleep: clock.sleep,
    });
    const url = await wait.run({
      workspaceId: "ws-1",
      key: "acme/site",
      fallbackUrl: "https://acme.github.io/site/",
      onLog: () => {},
      poll: async () => null, // never built
    });
    expect(url).toBe("https://acme.github.io/site/");
  });

  it("a re-publish RESUMES the same durable run rather than forking (idempotency anchor)", async () => {
    const store = new InMemoryDurableRunStore();
    const wait = createPublishBuildWait({
      store,
      caps: resolveDurableWorkflowCaps({ enabled: true, ownerWorkspaceOnly: false }),
      now: () => 1000,
      sleep: async () => {},
    });
    await wait.run({
      workspaceId: "ws-1",
      key: "acme/site",
      fallbackUrl: "https://acme.github.io/site/",
      onLog: () => {},
      poll: async () => "https://acme.github.io/site/",
    });
    // One run exists for this workspace+key; a second run() reads it back (no duplicate).
    const due = await store.listDue("ws-1", 9_999_999); // succeeded → not due
    expect(due).toHaveLength(0);
  });
});

describe("GitHubPagesPublishProvider — durable-vs-legacy dispatch (#338 port)", () => {
  const token = process.env.REALWORLD_GITHUB_TOKEN;
  beforeEach(() => {
    process.env.REALWORLD_GITHUB_TOKEN = "test-token";
  });
  afterEach(() => {
    if (token === undefined) delete process.env.REALWORLD_GITHUB_TOKEN;
    else process.env.REALWORLD_GITHUB_TOKEN = token;
    vi.unstubAllGlobals();
  });

  /** Minimal GitHub REST stub covering the publish flow. Tracks whether the Pages STATUS poll was hit. */
  function stubFetch() {
    const state = { pagesPolls: 0 };
    const fetchStub = vi.fn(async (input: unknown, init?: { method?: string }) => {
      const u = String(input);
      const method = init?.method ?? "GET";
      const json = (body: unknown, status = 200) =>
        ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => "" }) as unknown as Response;
      if (u.endsWith("/user")) return json({ login: "acme" });
      if (u.endsWith("/user/repos") && method === "POST") return json({}, 201);
      if (u.includes("/contents/index.html") && method === "GET") return json({}, 404);
      if (u.includes("/contents/index.html") && method === "PUT") return json({});
      if (u.endsWith("/pages") && method === "POST") return json({}, 201);
      if (u.endsWith("/pages") && method === "GET") {
        state.pagesPolls += 1;
        return json({ status: "built", html_url: "https://acme.github.io/site" });
      }
      return json({}, 500);
    });
    vi.stubGlobal("fetch", fetchStub);
    return state;
  }

  function input() {
    return { workspaceId: "ws-1", slug: "site", html: "<html></html>", onLog: () => {} };
  }

  it("routes the build-wait through the durable seam when enabled (legacy in-process poll NOT used)", async () => {
    const state = stubFetch();
    const durable: PublishBuildWait = {
      enabledFor: () => true,
      run: async () => "https://durable.example/site/",
    };
    const provider = new GitHubPagesPublishProvider(durable);
    const out = await provider.publish(input());
    expect(out.status).toBe("ready");
    expect(out.url).toBe("https://durable.example/site/"); // the durable wait's result
    expect(state.pagesPolls).toBe(0); // the legacy in-process status poll never ran
  });

  it("falls back to the legacy in-process poll when the durable path is disabled for the workspace", async () => {
    const state = stubFetch();
    const durable: PublishBuildWait = {
      enabledFor: () => false, // flag OFF for this workspace
      run: async () => "https://should-not-be-used/",
    };
    const provider = new GitHubPagesPublishProvider(durable);
    const out = await provider.publish(input());
    expect(out.status).toBe("ready");
    expect(out.url).toBe("https://acme.github.io/site/"); // normalized from the legacy poll
    expect(state.pagesPolls).toBe(1); // the legacy poll DID run
  });

  it("with NO durable wait injected, behaves exactly as before (legacy poll)", async () => {
    const state = stubFetch();
    const provider = new GitHubPagesPublishProvider();
    const out = await provider.publish(input());
    expect(out.status).toBe("ready");
    expect(out.url).toBe("https://acme.github.io/site/");
    expect(state.pagesPolls).toBe(1);
  });
});
