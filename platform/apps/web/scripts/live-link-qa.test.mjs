import test from "node:test";
import assert from "node:assert/strict";
import { extractHrefUrls, extractSitemapUrls, normalizeLink, runLiveLinkQa } from "./live-link-qa.mjs";

function response(status, body = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

function fakeFetch(routes) {
  return async (url) => {
    const hit = routes[url];
    if (!hit) return response(404, "not found");
    return response(hit.status ?? 200, hit.body ?? "");
  };
}

test("extractSitemapUrls reads loc entries", () => {
  assert.deepEqual(
    extractSitemapUrls("<urlset><url><loc>https://ipop.ai/</loc></url><url><loc>https://ipop.ai/pricing</loc></url></urlset>"),
    ["https://ipop.ai/", "https://ipop.ai/pricing"],
  );
});

test("normalizeLink skips non-http navigations and strips fragments", () => {
  assert.equal(normalizeLink("mailto:support@ipop.ai", "https://ipop.ai/"), null);
  assert.equal(normalizeLink("#pricing", "https://ipop.ai/"), null);
  assert.equal(normalizeLink("/pricing#faq", "https://ipop.ai/"), "https://ipop.ai/pricing");
});

test("extractHrefUrls finds absolute same-origin candidates without fragments", () => {
  assert.deepEqual(
    extractHrefUrls('<a href="/dashboard">Dashboard</a><a href="https://ipop.ai/pricing#faq">Pricing</a>', "https://ipop.ai/"),
    ["https://ipop.ai/dashboard", "https://ipop.ai/pricing"],
  );
});

test("runLiveLinkQa fails when a same-origin href returns 404", async () => {
  const result = await runLiveLinkQa({
    target: "https://ipop.ai/",
    fetcher: fakeFetch({
      "https://ipop.ai/sitemap.xml": {
        body: "<urlset><url><loc>https://ipop.ai/</loc></url></urlset>",
      },
      "https://ipop.ai/": {
        body: '<a href="/dashboard">Dashboard</a>',
      },
      "https://ipop.ai/dashboard": {
        status: 404,
        body: "not found",
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [{ kind: "link", url: "https://ipop.ai/dashboard", status: 404 }]);
});

test("runLiveLinkQa passes when sitemap pages and same-origin links resolve", async () => {
  const result = await runLiveLinkQa({
    target: "https://ipop.ai/",
    fetcher: fakeFetch({
      "https://ipop.ai/sitemap.xml": {
        body: "<urlset><url><loc>https://ipop.ai/</loc></url><url><loc>https://ipop.ai/pricing</loc></url></urlset>",
      },
      "https://ipop.ai/": {
        body: '<a href="/dashboard">Dashboard</a><a href="/pricing">Pricing</a>',
      },
      "https://ipop.ai/pricing": {
        body: '<a href="/">Home</a>',
      },
      "https://ipop.ai/dashboard": {
        body: "dashboard shell",
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.pages, 2);
  assert.equal(result.links, 3);
});
