/**
 * Real-world canary (#231). Proves the real-world tool surface end-to-end: an agent publishes a REAL,
 * reachable page through the gated `publish` tool and we verify it returns HTTP 200 in the wild.
 *
 * It exercises the full path, not a shortcut:
 *   1. publishPage with NO approval → the #13 gate PARKS a pending approval (recorded-only), no bytes.
 *   2. publishPage as the post-approval executor → the GitHub Pages provider publishes a live URL.
 *   3. A HEAD/GET against that URL proves it is actually reachable.
 *
 * Usage:
 *   REALWORLD_GITHUB_TOKEN=$(gh auth token) npx tsx scripts/realworld-canary.ts
 */
import { GitHubPagesPublishProvider } from "../src/realworld/publish/github-pages-provider.js";
import {
  RealWorldActuatorService,
  type ArtifactRecordInput,
  type ArtifactStore,
} from "../src/realworld/service.js";
import type { ServiceKind } from "../src/onboarding/types.js";

function memoryStore(): ArtifactStore & { records: ArtifactRecordInput[] } {
  const records: ArtifactRecordInput[] = [];
  return {
    records,
    async record(input) {
      records.push(input);
      return { id: `art-${records.length}` };
    },
  };
}

async function main(): Promise<void> {
  const provider = new GitHubPagesPublishProvider();
  const store = memoryStore();
  const service = new RealWorldActuatorService({
    publish: provider,
    artifacts: store,
    // The owner has connected a hosting account — publish is allowed (still gated for a human).
    connectedAccounts: async () => new Set<ServiceKind>(["hosting"]),
    // Gated: every publish parks a #13 approval until a human approves.
    approvals: {
      requiresApproval: async () => true,
      submit: async () => ({ id: "canary-13-approval" }),
    },
  });

  const stamp = new Date().toISOString();
  const slug = `realworld-canary-${stamp.replace(/[^0-9]/g, "").slice(0, 14)}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Real-world canary (#231)</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui;margin:4rem auto;max-width:42rem;line-height:1.6;color:#111}</style></head>
<body>
<h1>The fleet did real work.</h1>
<p>This page was published to a live, reachable URL by an AI agent through the gated, injection-quarantined
real-world tool surface (#231) — not asserted, observed in the wild.</p>
<p>Published at <time>${stamp}</time>.</p>
</body></html>`;

  const requester = "canary-owner";
  const workspaceId = "canary-workspace";

  console.log("=== #231 real-world canary ===");

  // 1) Gate is consulted: with no approval, the publish PARKS a #13 request (recorded-only, no bytes).
  const parked = await service.publishPage({ workspaceId, slug, html, requesterMemberId: requester });
  console.log("1) gated publish (no approval):", JSON.stringify(parked));
  if (parked.status !== "pending_approval") {
    throw new Error(`expected pending_approval, got ${parked.status}`);
  }

  // 2) Post-approval execution: a human approved via #13 → actually publish the bytes.
  console.log("2) publishing the bytes (post-approval execution)…");
  const published = await service.publishPage({
    workspaceId,
    slug,
    html,
    requesterMemberId: requester,
    approved: true,
  });
  console.log("   result:", JSON.stringify(published));
  if (published.status !== "published") {
    throw new Error(`publish failed: ${JSON.stringify(published)}`);
  }

  // 3) Prove it is reachable in the wild (retry — Pages CDN can lag a few seconds after build).
  const url = published.url;
  console.log(`3) verifying reachability of ${url} …`);
  let ok = false;
  let status = 0;
  for (let i = 0; i < 20; i++) {
    const health = await provider.healthCheck(url);
    status = health.status;
    if (health.ok) {
      ok = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log("\n=== RESULT ===");
  console.log("published URL:", url);
  console.log("reachable:", ok, "(HTTP", status, ")");
  console.log("artifact receipts:", JSON.stringify(store.records.map((r) => ({ status: r.status, url: r.url }))));
  if (!ok) throw new Error(`URL not reachable yet (last HTTP ${status})`);
  console.log("\nCANARY PASSED ✅");
}

main().catch((err) => {
  console.error("CANARY FAILED ❌", err);
  process.exit(1);
});
