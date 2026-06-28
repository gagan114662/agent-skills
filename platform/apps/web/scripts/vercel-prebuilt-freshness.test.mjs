import test from "node:test";
import assert from "node:assert/strict";
import { runVercelPrebuiltFreshness } from "./vercel-prebuilt-freshness.mjs";

const freshHtml = `<!doctype html>
<html><head><meta name="reload-build-sha" content="abcdef123456" /></head>
<body><h1>Make marketing pop.</h1><p>marketing team in your messages</p></body></html>`;

test("runVercelPrebuiltFreshness passes for the expected prebuilt stamp", async () => {
  const result = await runVercelPrebuiltFreshness({
    expectedSha: "abcdef1",
    indexPath: ".vercel/output/static/index.html",
    cwd: "/repo/apps/web",
    reader: async (path, encoding) => {
      assert.equal(path, "/repo/apps/web/.vercel/output/static/index.html");
      assert.equal(encoding, "utf8");
      return freshHtml;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.liveSha, "abcdef123456");
  assert.deepEqual(result.failures, []);
});

test("runVercelPrebuiltFreshness fails before upload when the prebuilt output is stale", async () => {
  const result = await runVercelPrebuiltFreshness({
    expectedSha: "deadbee",
    reader: async () => freshHtml,
  });

  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /live homepage is on abcdef123456, expected deadbee/);
});
