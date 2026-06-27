import test from "node:test";
import assert from "node:assert/strict";
import { evaluateFreshness, extractBuildSha, sameCommit } from "./production-freshness.mjs";

const freshHtml = `<!doctype html>
<html><head><meta name="reload-build-sha" content="abcdef123456" /></head>
<body><h1>Make marketing pop.</h1><p>marketing team in your messages</p></body></html>`;

test("extractBuildSha reads the prerendered build stamp", () => {
  assert.equal(extractBuildSha(freshHtml), "abcdef123456");
  assert.equal(extractBuildSha("<html></html>"), null);
});

test("sameCommit accepts abbreviated SHAs in either direction", () => {
  assert.equal(sameCommit("abcdef123456", "abcdef1"), true);
  assert.equal(sameCommit("abcdef1", "abcdef123456"), true);
  assert.equal(sameCommit("abcdef1", "deadbee"), false);
});

test("evaluateFreshness passes only when stamp and homepage contract match", () => {
  const result = evaluateFreshness({ html: freshHtml, expectedSha: "abcdef1" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("evaluateFreshness fails loudly on old live homepage copy", () => {
  const staleHtml = `<!doctype html><html><head></head><body>
    <h1>The marketing agency of AI agents</h1>
    <a>Start free</a><a>Watch live demo</a>
  </body></html>`;
  const result = evaluateFreshness({ html: staleHtml, expectedSha: "abcdef1" });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /no <meta name="reload-build-sha"> stamp/);
  assert.match(result.failures.join("\n"), /missing required text/);
  assert.match(result.failures.join("\n"), /stale text/);
});
