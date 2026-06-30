import test from "node:test";
import assert from "node:assert/strict";
import { formatProductionStatus, resolveApiVersionUrl, runProductionStatus } from "./production-status.mjs";

const freshHtml = `<!doctype html><html><head><meta name="reload-build-sha" content="abcdef123456" /></head>
<body><h1>Make marketing pop.</h1><p>marketing team in your messages</p></body></html>`;

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Nope",
    text: async () => body,
  };
}

function fakeFetch(routes) {
  return async (url) => routes[url] ?? response(404, "not found");
}

test("resolveApiVersionUrl uses api.ipop.ai for the production split deployment", () => {
  assert.equal(resolveApiVersionUrl("https://ipop.ai/"), "https://api.ipop.ai/version");
  assert.equal(resolveApiVersionUrl("https://preview.example.com/"), "https://preview.example.com/version");
  assert.equal(resolveApiVersionUrl("https://ipop.ai/", "https://custom.example/version"), "https://custom.example/version");
});

test("runProductionStatus reports web and API SHAs separately", async () => {
  const result = await runProductionStatus({
    webTarget: "https://ipop.ai/",
    expectedSha: "abcdef1",
    fetcher: fakeFetch({
      "https://ipop.ai/": response(200, freshHtml),
      "https://api.ipop.ai/version": response(200, JSON.stringify({ version: "deadbeef1234" })),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.web.sha, "abcdef123456");
  assert.equal(result.api.sha, "deadbeef1234");
  assert.equal(result.api.matchesExpectedWebSha, false);
  assert.match(formatProductionStatus(result), /API SHA differs from expected web SHA/);
});

test("runProductionStatus can be used as a local report without EXPECTED_WEB_SHA", async () => {
  const result = await runProductionStatus({
    webTarget: "https://ipop.ai/",
    expectedSha: undefined,
    fetcher: fakeFetch({
      "https://ipop.ai/": response(200, freshHtml),
      "https://api.ipop.ai/version": response(200, JSON.stringify({ version: "deadbeef1234" })),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.expectedWebSha, null);
  assert.equal(result.web.sha, "abcdef123456");
});

test("runProductionStatus fails when the web stamp is stale", async () => {
  const result = await runProductionStatus({
    webTarget: "https://ipop.ai/",
    expectedSha: "feedface",
    fetcher: fakeFetch({
      "https://ipop.ai/": response(200, freshHtml),
      "https://api.ipop.ai/version": response(200, JSON.stringify({ version: "feedface9999" })),
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.web.failures.join("\n"), /live homepage is on/);
});
