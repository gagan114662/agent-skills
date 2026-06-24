import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { SearchConsoleService } from "../../src/search-console/service.js";

vi.mock("../../src/auth/guard.js", () => ({
  requireIdentity: vi.fn(async () => ({
    workspaceId: "ws-1",
    memberId: "member-1",
  })),
}));

const {
  MAX_SEARCH_CONSOLE_SUBMIT_URLS,
  MAX_SEARCH_CONSOLE_URL_CHARS,
  searchConsoleRoutes,
} = await import("../../src/routes/search-console.js");

function service() {
  return {
    summary: vi.fn(async () => ({})),
    submitSitemap: vi.fn(async () => ({ status: "pending_approval", approvalRequestId: "appr-1" })),
  };
}

async function appWith(svc: ReturnType<typeof service>) {
  const app = Fastify();
  await app.register(searchConsoleRoutes, { service: svc as unknown as SearchConsoleService });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Search Console submit route bounds", () => {
  it("rejects an over-limit urls array before service work", async () => {
    const svc = service();
    const app = await appWith(svc);

    const res = await app.inject({
      method: "POST",
      url: "/me/seo/search-console/submit",
      payload: { urls: Array.from({ length: MAX_SEARCH_CONSOLE_SUBMIT_URLS + 1 }, (_, i) => `https://x.test/${i}`) },
    });

    expect(res.statusCode).toBe(400);
    expect(svc.submitSitemap).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects over-long sitemap and indexing URLs before service work", async () => {
    const svc = service();
    const app = await appWith(svc);
    const tooLong = `https://x.test/${"a".repeat(MAX_SEARCH_CONSOLE_URL_CHARS)}`;

    const sitemap = await app.inject({
      method: "POST",
      url: "/me/seo/search-console/submit",
      payload: { sitemapUrl: tooLong },
    });
    const urls = await app.inject({
      method: "POST",
      url: "/me/seo/search-console/submit",
      payload: { urls: [tooLong] },
    });

    expect(sitemap.statusCode).toBe(400);
    expect(urls.statusCode).toBe(400);
    expect(svc.submitSitemap).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts the boundary-sized urls array unchanged", async () => {
    const svc = service();
    const app = await appWith(svc);
    const urls = Array.from({ length: MAX_SEARCH_CONSOLE_SUBMIT_URLS }, (_, i) => `https://x.test/${i}`);

    const res = await app.inject({
      method: "POST",
      url: "/me/seo/search-console/submit",
      payload: { sitemapUrl: "https://x.test/sitemap.xml", urls },
    });

    expect(res.statusCode).toBe(200);
    expect(svc.submitSitemap).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      requesterMemberId: "member-1",
      sitemapUrl: "https://x.test/sitemap.xml",
      urls,
    });
    await app.close();
  });
});
