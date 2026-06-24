import { describe, it, expect, vi, afterEach } from "vitest";
import {
  GitHubSitePublisher,
  IpopHostedSitePublisher,
  NotConnectedSitePublisher,
  resolveSitePublisher,
  type SitePrPublishing,
  type SitePublisher,
} from "../../src/realworld/publish/site-publisher.js";
import { SITE_PUBLISH_GITHUB_ID } from "../../src/connections/registry.js";
import type { IpopSitePublishResult } from "../../src/realworld/service.js";

/**
 * #258 — `publish_site` calls an abstract {@link SitePublisher}. GitHub is ONE internal impl (ipop.ai's
 * own mechanism, token from a per-workspace connection — NOT a Fly env secret). `ipop-hosted` and the
 * OAuth "Connect your website" path slot in behind the same interface as the customer default to come.
 */

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A fake inner publishing service (structural) so the adapter can be tested without IO. */
function fakeInner(result: IpopSitePublishResult): SitePrPublishing & { calls: number } {
  return {
    calls: 0,
    async publish() {
      this.calls++;
      return result;
    },
  };
}

describe("SitePublisher abstraction (#258)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GitHubSitePublisher maps an inner published PR to a SitePublishResult", async () => {
    const inner = fakeInner({
      status: "published",
      prUrl: "https://github.com/ipop/site/pull/3",
      branch: "ipop-content/post",
      path: "content/blog/post.md",
      providerId: "ipop/site",
    });
    const pub = new GitHubSitePublisher(inner);
    expect(pub.kind).toBe("github");
    const res = await pub.publish({ workspaceId: "w1", title: "Post", content: "x" });
    expect(res).toMatchObject({
      status: "published",
      kind: "github",
      url: "https://github.com/ipop/site/pull/3",
      prUrl: "https://github.com/ipop/site/pull/3",
      branch: "ipop-content/post",
      path: "content/blog/post.md",
    });
  });

  it("GitHubSitePublisher maps inner rejected/failed verbatim", async () => {
    const rej = await new GitHubSitePublisher(fakeInner({ status: "rejected", reason: "empty" })).publish({
      workspaceId: "w1",
      title: "",
      content: "x",
    });
    expect(rej).toMatchObject({ status: "rejected", reason: "empty" });
    const fail = await new GitHubSitePublisher(fakeInner({ status: "failed", error: "github 500" })).publish({
      workspaceId: "w1",
      title: "Post",
      content: "x",
    });
    expect(fail).toMatchObject({ status: "failed", error: "github 500" });
  });

  it("IpopHostedSitePublisher is a first-class SitePublisher (the customer default to come)", async () => {
    const pub: SitePublisher = new IpopHostedSitePublisher();
    expect(pub.kind).toBe("ipop_hosted");
    const res = await pub.publish({ workspaceId: "w1", title: "Post", content: "x" });
    expect(res.status).toBe("not_connected");
  });

  it("NotConnectedSitePublisher reports no publishing connection", async () => {
    const res = await new NotConnectedSitePublisher().publish({ workspaceId: "w1", title: "Post", content: "x" });
    expect(res).toMatchObject({ status: "not_connected" });
  });

  describe("resolveSitePublisher", () => {
    it("uses the per-workspace internal GitHub connection token (no env secret)", async () => {
      delete process.env.REALWORLD_GITHUB_TOKEN;
      let seenAuth: string | undefined;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        seenAuth = ((init?.headers ?? {}) as Record<string, string>).Authorization;
        const method = init?.method ?? "GET";
        if (url.includes("/git/ref/heads/")) return jsonRes({ object: { sha: "s" } });
        if (url.endsWith("/git/refs") && method === "POST") return jsonRes({}, 201);
        if (url.includes("/contents/") && method === "GET") return jsonRes({}, 404);
        if (url.includes("/contents/") && method === "PUT") return jsonRes({}, 201);
        if (url.endsWith("/pulls") && method === "POST")
          return jsonRes({ html_url: "https://github.com/acme/site/pull/1" }, 201);
        throw new Error(`unexpected ${method} ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const pub = await resolveSitePublisher("w1", {
        readConnectionSecrets: async (_w, id) =>
          id === SITE_PUBLISH_GITHUB_ID
            ? { REALWORLD_GITHUB_TOKEN: "tok_conn", REALWORLD_SITE_REPO: "acme/site" }
            : {},
        config: {},
      });
      expect(pub.kind).toBe("github");
      const res = await pub.publish({ workspaceId: "w1", title: "Post", content: "# Post\n\nThis is the complete body." });
      expect(res.status).toBe("published");
      expect(seenAuth).toBe("Bearer tok_conn");
    });

    it("falls back to a dry-run publisher when no connection and no github config (internal default)", async () => {
      const pub = await resolveSitePublisher("w1", {
        readConnectionSecrets: async () => ({}),
        config: {},
      });
      const res = await pub.publish({ workspaceId: "w1", title: "Why AI Wins", content: "# Why AI wins\n\nThis is the complete body." });
      expect(res.status).toBe("published");
      if (res.status !== "published") return;
      expect(res.prUrl).toContain("/pull/dryrun-");
      expect(res.path).toBe("content/blog/why-ai-wins.md");
    });
  });
});
