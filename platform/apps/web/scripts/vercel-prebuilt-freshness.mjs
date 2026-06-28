#!/usr/bin/env node
/**
 * Guard for manual Vercel prebuilt deploys (#1321). `vercel deploy --prebuilt` uploads
 * .vercel/output, not the app's dist/ directory. This fails before upload when that artifact is stale.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateFreshness } from "./production-freshness.mjs";

export const DEFAULT_PREBUILT_INDEX = ".vercel/output/static/index.html";

export async function runVercelPrebuiltFreshness({
  expectedSha = process.env.EXPECTED_WEB_SHA || process.env.VITE_RELOAD_BUILD_SHA || process.env.RELOAD_BUILD_SHA || process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA,
  indexPath = process.env.VERCEL_PREBUILT_INDEX || DEFAULT_PREBUILT_INDEX,
  cwd = process.cwd(),
  reader = readFile,
} = {}) {
  const fullPath = join(cwd, indexPath);
  const html = await reader(fullPath, "utf8");
  return { indexPath, fullPath, ...evaluateFreshness({ html, expectedSha }) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runVercelPrebuiltFreshness({ expectedSha: process.argv[2] || undefined })
    .then((result) => {
      if (result.ok) {
        console.log(`vercel prebuilt fresh: ${result.indexPath} is on ${result.liveSha}`);
        return;
      }
      console.error(`vercel prebuilt stale: ${result.indexPath}`);
      for (const failure of result.failures) console.error(`- ${failure}`);
      process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
