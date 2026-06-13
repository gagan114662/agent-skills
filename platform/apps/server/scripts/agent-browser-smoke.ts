/**
 * Agent browser runtime smoke (#174, ADR-0174) — the post-deploy proof that the image's browser can
 * ACTUALLY spawn and drive a real page through the harness path. This closes the #166 lesson ("never
 * ship an image whose runtime can't spawn") for the browser: it launches the real Playwright Chromium
 * via {@link createPlaywrightDriver}, opens an isolated session through the {@link BrowserSessionManager},
 * loads a live page, reads it, screenshots it, and asserts a receipt — then proves the safety contract
 * is live in prod by showing a side-effectful click is REFUSED without a #13 approval.
 *
 * It exits non-zero on any failure, so it can gate a deploy. It needs the optional `playwright` package
 * (so it is NOT run in the default CI unit job); run it against a freshly-built runtime image:
 *
 *   pnpm --filter @reload/server add playwright && npx playwright install --with-deps chromium
 *   SMOKE_TARGET=https://example.com pnpm --filter @reload/server agent:browser-smoke
 */
import { resolveBrowserCaps } from "../src/runtime/browser/caps.js";
import { createPlaywrightDriver } from "../src/runtime/browser/driver.js";
import { pendingApprovalGate } from "../src/runtime/browser/approval.js";
import { BrowserSessionManager } from "../src/runtime/browser/manager.js";

async function main(): Promise<void> {
  const target = process.env.SMOKE_TARGET?.trim() || "https://example.com";
  console.log(`[browser-smoke] launching real Chromium and loading ${target} ...`);

  const driver = await createPlaywrightDriver();
  const manager = new BrowserSessionManager({
    driver,
    // The smoke runs with the browser force-enabled regardless of the deployment flag.
    loadCaps: () => resolveBrowserCaps({ enabled: true }),
    approvalGate: pendingApprovalGate(),
  });

  try {
    const session = await manager.open({ sessionId: "browser-smoke", workspaceId: "browser-smoke" });

    const nav = await session.navigate(target);
    if (!nav.ok || (nav.status ?? 0) < 200 || (nav.status ?? 0) >= 400) {
      throw new Error(`navigation failed (ok=${nav.ok}, status=${nav.status}): ${nav.reason}`);
    }
    console.log(`[browser-smoke] navigate ok — status ${nav.status}, receipt screenshot: ${nav.screenshotPath}`);

    const read = await session.readPage();
    if (!read.ok || !read.page) throw new Error(`read_page failed: ${read.reason}`);
    console.log(`[browser-smoke] read_page ok — title "${read.page.title}" (${read.page.text.length} chars)`);

    const shot = await session.takeScreenshot();
    if (!shot.ok || !shot.screenshot) throw new Error(`screenshot failed: ${shot.reason}`);
    console.log(`[browser-smoke] screenshot ok — ${shot.screenshot.length} base64 chars`);

    // Safety contract is LIVE in prod: a side-effectful click must refuse without a #13 approval.
    const click = await session.click("a");
    if (click.ok || click.decision !== "needs_approval") {
      throw new Error(`SAFETY VIOLATION: a click ran without approval (decision=${click.decision})`);
    }
    console.log(`[browser-smoke] safety ok — unapproved click refused (#13): ${click.reason}`);

    await manager.close("browser-smoke");
    console.log("[browser-smoke] PASS — the image's browser spawns and drives a real page.");
  } finally {
    const closeable = driver as { shutdown?: () => Promise<void> };
    if (closeable.shutdown) await closeable.shutdown();
  }
}

main().catch((err) => {
  console.error(`[browser-smoke] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
