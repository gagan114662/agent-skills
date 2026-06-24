import { describe, it, expect, vi, afterEach } from "vitest";
import { decidePublishToIpop, slugify } from "../../src/realworld/publish/site-pr-decide.js";
import {
  DryRunSitePrProvider,
  GitHubSitePrProvider,
  type SitePrProvider,
  type SitePrInput,
} from "../../src/realworld/publish/site-pr-provider.js";
import { IpopSitePublishService, type ArtifactRecordInput } from "../../src/realworld/service.js";

// ---------------------------------------------------------------------------------------------------
// Pure plan (#250)
// ---------------------------------------------------------------------------------------------------

describe("decidePublishToIpop (#250) — pure plan", () => {
  const opts = { contentDir: "content/blog" };

  it("derives a slugged, traversal-proof path + branch from the title", () => {
    const plan = decidePublishToIpop(
      { title: "Why AI Marketing Wins!", content: "# Why AI marketing wins\n\nAI marketing wins because it scales personalization." },
      opts,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.slug).toBe("why-ai-marketing-wins");
    expect(plan.path).toBe("content/blog/why-ai-marketing-wins.md");
    expect(plan.branch).toBe("ipop-content/why-ai-marketing-wins");
    expect(plan.title).toBe("Why AI Marketing Wins!");
    expect(plan.body).toContain("content/blog/why-ai-marketing-wins.md");
  });

  it("a malicious title/slug can never escape the content dir (no traversal, charset [a-z0-9-])", () => {
    const plan = decidePublishToIpop(
      { title: "../../etc/passwd", content: "This is a complete, publishable body.", slug: "../../../secret" },
      opts,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.path.startsWith("content/blog/")).toBe(true);
    expect(plan.path).not.toContain("..");
    expect(plan.slug).toBe("secret");
  });

  it("honors an explicit slug + extension", () => {
    const plan = decidePublishToIpop(
      { title: "Post", content: "A complete body sentence.", slug: "My Post", extension: "mdx" },
      opts,
    );
    expect(plan.ok && plan.path).toBe("content/blog/my-post.mdx");
  });

  it("normalises a content dir, stripping stray slashes and traversal segments", () => {
    const plan = decidePublishToIpop(
      { title: "Post", content: "A complete body sentence." },
      { contentDir: "/content/../blog/" },
    );
    // `..` is stripped (not resolved) — traversal-proof; the remaining segments are kept verbatim.
    expect(plan.ok && plan.path).toBe("content/blog/post.md");
  });

  it("rejects an empty title, empty content, an unknown extension, and an unslugglable title", () => {
    expect(decidePublishToIpop({ title: "", content: "A complete body." }, opts)).toMatchObject({ ok: false });
    expect(decidePublishToIpop({ title: "t", content: "  " }, opts)).toMatchObject({ ok: false });
    expect(decidePublishToIpop({ title: "t", content: "A complete body.", extension: "exe" }, opts)).toMatchObject({ ok: false });
    expect(decidePublishToIpop({ title: "!!!", content: "A complete body." }, opts)).toMatchObject({ ok: false });
  });

  it("rejects a body that carries agent working-notes / chatter markers (#250 — debris draft)", () => {
    // A self-publish body that still contains A2A handoff chatter or an SEO planning scratchpad is an
    // internal artifact, not a finished post — it must never become a blog PR.
    const chatter = [
      "Here is a real intro sentence.\n\n@scout can you confirm the angle?",
      "Intro.\n\n@quill draft the body please.",
      "Body.\n\n[A2A handoff: writer → editor]",
      "Body text.\n\nhandoff-chain: scout -> strategist -> writer",
      "Keyword pick: best ai marketing tools",
      "Target keyword: ai marketing\n\nIntro.",
      "Meta description: a punchy summary goes here.",
      "Suggested URL: /blog/ai-marketing",
      "Nothing publishes without a human flip.",
      "This is a draft only — do not ship.",
      "Looks good, leaving this for a human to review.",
      "Notes for the human reviewer: tighten the intro.",
    ];
    for (const content of chatter) {
      const res = decidePublishToIpop({ title: "A Good Title", content }, opts);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toMatch(/internal draft/i);
    }
  });

  it("rejects a truncated body (final visible line lacks sentence-ending punctuation) (#250)", () => {
    // Cut off mid-thought — the classic incomplete debris draft.
    const res = decidePublishToIpop(
      { title: "A Good Title", content: "# Heading\n\nThis sentence is cut off and never quite finishes" },
      opts,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/truncated/i);

    // A real post that ends in a sentence followed ONLY by a trailing badge/link line is NOT truncated:
    // the trailing markdown link line is ignored before the punctuation check.
    const withBadge = decidePublishToIpop(
      {
        title: "A Good Title",
        content: "# Heading\n\nThis is the complete final sentence.\n\n[![Built with ipop](badge.svg)](https://ipop.ai)",
      },
      opts,
    );
    expect(withBadge.ok).toBe(true);
  });

  it("slugify is deterministic and capped", () => {
    expect(slugify("A B C")).toBe("a-b-c");
    expect(slugify("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

// ---------------------------------------------------------------------------------------------------
// Providers (#250)
// ---------------------------------------------------------------------------------------------------

describe("DryRunSitePrProvider (#250)", () => {
  it("returns a deterministic fake PR url with no network", async () => {
    const out = await new DryRunSitePrProvider("ipop/site").openPr({
      workspaceId: "w1",
      path: "content/blog/post.md",
      content: "x",
      title: "t",
      body: "b",
      branch: "ipop-content/post",
      onLog: () => undefined,
    });
    expect(out.status).toBe("ready");
    expect(out.prUrl).toBe("https://github.com/ipop/site/pull/dryrun-ipop-content/post");
    expect(out.providerId).toBe("ipop/site");
  });
});

describe("GitHubSitePrProvider (#250) — REST sequence", () => {
  afterEach(() => vi.unstubAllGlobals());

  const input: SitePrInput = {
    workspaceId: "w1",
    path: "content/blog/post.md",
    content: "# hello",
    title: "New post",
    body: "adds a post",
    branch: "ipop-content/new-post",
    onLog: () => undefined,
  };

  it("gets the base sha, creates the branch, commits the file, and opens a PR", async () => {
    process.env.REALWORLD_GITHUB_TOKEN = "tok_test";
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes("/git/ref/heads/")) return jsonRes({ object: { sha: "basesha" } });
      if (url.endsWith("/git/refs") && method === "POST") return jsonRes({}, 201);
      if (url.includes("/contents/") && method === "GET") return jsonRes({}, 404); // no existing file
      if (url.includes("/contents/") && method === "PUT") return jsonRes({}, 201);
      if (url.endsWith("/pulls") && method === "POST")
        return jsonRes({ html_url: "https://github.com/ipop/site/pull/7" }, 201);
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await new GitHubSitePrProvider({ repo: "ipop/site", baseBranch: "main" }).openPr(input);
    expect(out).toMatchObject({ status: "ready", prUrl: "https://github.com/ipop/site/pull/7", providerId: "ipop/site" });

    const seq = calls.map((c) => `${c.method} ${c.url.replace("https://api.github.com/repos/ipop/site", "")}`);
    expect(seq).toContain("GET /git/ref/heads/main");
    expect(seq).toContain("POST /git/refs");
    expect(seq).toContain("PUT /contents/content/blog/post.md");
    expect(seq).toContain("POST /pulls");
    const branchCreate = calls.find((c) => c.url.endsWith("/git/refs"));
    expect(branchCreate?.body).toMatchObject({ ref: "refs/heads/ipop-content/new-post", sha: "basesha" });
  });

  it("throws if constructed without a repo (defensive guard — repo is interpolated into API URLs)", () => {
    expect(() => new GitHubSitePrProvider({ repo: "" })).toThrow(/repo/i);
    // @ts-expect-error — intentionally omit repo to prove the runtime guard
    expect(() => new GitHubSitePrProvider({})).toThrow(/repo/i);
  });

  it("returns an error outcome (never throws) when the token is missing", async () => {
    delete process.env.REALWORLD_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const out = await new GitHubSitePrProvider({ repo: "ipop/site" }).openPr(input);
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/REALWORLD_GITHUB_TOKEN/);
  });

  it("uses an injected per-workspace token (the connection) over the env secret", async () => {
    // The internal GitHub publisher is now fed its token from the per-workspace #192 connection, NOT a
    // Fly env secret. Prove the injected token wins even when no env var is set.
    delete process.env.REALWORLD_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    let seenAuth: string | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenAuth = headers.Authorization;
      const method = init?.method ?? "GET";
      if (url.includes("/git/ref/heads/")) return jsonRes({ object: { sha: "basesha" } });
      if (url.endsWith("/git/refs") && method === "POST") return jsonRes({}, 201);
      if (url.includes("/contents/") && method === "GET") return jsonRes({}, 404);
      if (url.includes("/contents/") && method === "PUT") return jsonRes({}, 201);
      if (url.endsWith("/pulls") && method === "POST")
        return jsonRes({ html_url: "https://github.com/ipop/site/pull/11" }, 201);
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await new GitHubSitePrProvider({ repo: "ipop/site", token: "tok_connection" }).openPr(input);
    expect(out.status).toBe("ready");
    expect(seenAuth).toBe("Bearer tok_connection");
  });
});

// ---------------------------------------------------------------------------------------------------
// Autonomous service (#250)
// ---------------------------------------------------------------------------------------------------

function fakeProvider(outcome: Awaited<ReturnType<SitePrProvider["openPr"]>>): SitePrProvider & { calls: SitePrInput[] } {
  const calls: SitePrInput[] = [];
  return {
    kind: "fake",
    calls,
    async openPr(input) {
      calls.push(input);
      return outcome;
    },
  };
}

function fakeArtifacts(): { records: ArtifactRecordInput[]; record: (i: ArtifactRecordInput) => Promise<{ id: string }> } {
  const records: ArtifactRecordInput[] = [];
  return {
    records,
    async record(i) {
      records.push(i);
      return { id: `art_${records.length}` };
    },
  };
}

describe("IpopSitePublishService (#250) — autonomous, no #13 gate", () => {
  it("publishes a PR with no approval step and records a receipt", async () => {
    const provider = fakeProvider({ status: "ready", prUrl: "https://github.com/ipop/site/pull/9", branch: "ipop-content/post", providerId: "ipop/site" });
    const artifacts = fakeArtifacts();
    const svc = new IpopSitePublishService({ provider, contentDir: "content/blog", artifacts });

    const res = await svc.publish({ workspaceId: "w1", request: { title: "Post", content: "# Post\n\nThis is the complete body." } });
    expect(res).toMatchObject({ status: "published", prUrl: "https://github.com/ipop/site/pull/9", path: "content/blog/post.md" });
    // The provider was handed the planned commit — proving the autonomous path actually actuated.
    expect(provider.calls[0]?.path).toBe("content/blog/post.md");
    expect(provider.calls[0]?.branch).toBe("ipop-content/post");
    expect(artifacts.records.at(-1)).toMatchObject({ tool: "publish_site", status: "published" });
  });

  it("rejects an invalid request BEFORE touching the provider", async () => {
    const provider = fakeProvider({ status: "ready", prUrl: "x" });
    const svc = new IpopSitePublishService({ provider, contentDir: "content/blog" });
    const res = await svc.publish({ workspaceId: "w1", request: { title: "", content: "x" } });
    expect(res).toMatchObject({ status: "rejected" });
    expect(provider.calls).toHaveLength(0);
  });

  it("surfaces a provider failure as failed + a receipt", async () => {
    const provider = fakeProvider({ status: "error", error: "github 500" });
    const artifacts = fakeArtifacts();
    const svc = new IpopSitePublishService({ provider, contentDir: "content/blog", artifacts });
    const res = await svc.publish({ workspaceId: "w1", request: { title: "Post", content: "A complete body sentence." } });
    expect(res).toMatchObject({ status: "failed", error: "github 500" });
    expect(artifacts.records.at(-1)).toMatchObject({ tool: "publish_site", status: "failed" });
  });
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
