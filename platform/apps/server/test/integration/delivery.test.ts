import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { createChannel } from "../../src/db/repositories/channels.js";
import { createRequest } from "../../src/db/repositories/approvals.js";
import { resolveDeliveryDepartment } from "../../src/delivery/default.js";
import { createDeliveryDispatcher } from "../../src/delivery/dispatcher.js";
import {
  PublishChannelAdapter,
  SitePrChannelAdapter,
  SocialChannelAdapter,
  EmailChannelAdapter,
} from "../../src/delivery/adapters.js";
import { DryRunPublishProvider } from "../../src/realworld/publish/dry-run-provider.js";
import { GitHubSitePublisher } from "../../src/realworld/publish/site-publisher.js";
import { DryRunSitePrProvider } from "../../src/realworld/publish/site-pr-provider.js";
import { IpopSitePublishService } from "../../src/realworld/service.js";
import { dryRunSocialProvider, dryRunEspProvider } from "../../src/acquisition/providers.js";
import { dbDeliveryReceiptStore, listDeliveryReceipts, countLiveDeliveries } from "../../src/db/repositories/delivery.js";
import type { DeliveryFlags } from "../../src/delivery/decide.js";

/**
 * #295 — deliverable delivery, end-to-end on a real Postgres. Proves the parts unit tests (with fakes)
 * cannot:
 *  - `resolveDeliveryDepartment` maps a real channel ROW → its structural department (injection-safe);
 *  - the dispatcher persists a real `delivery_receipts` row tied to the #13 approval that authorized it;
 *  - the console reads (`listDeliveryReceipts` / `countLiveDeliveries`) reflect what actually shipped.
 *
 * The flags are forced on here (the layered-config gate is unit-tested separately) so the test is
 * deterministic and never mutates global env.
 */
let app: FastifyInstance;
const slugs: string[] = [];

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await closeDb();
});

async function newWorkspace(): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `deliv-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Owner", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId, memberId: me.memberId };
}

const ALL_ON: DeliveryFlags = { enabled: true, publish: true, site_pr: false, social: true, email: true };

/** A dry-run site-PR publisher (opens no real PR — exercises the wiring without a token/network). */
function dryRunSitePrAdapter(): SitePrChannelAdapter {
  return new SitePrChannelAdapter(
    new GitHubSitePublisher(
      new IpopSitePublishService({ provider: new DryRunSitePrProvider(), contentDir: "content/blog" }),
    ),
  );
}

/** A dispatcher over the REAL channel resolver + REAL receipt store, with flags forced on. */
function dispatcher(flags: DeliveryFlags = ALL_ON) {
  return createDeliveryDispatcher({
    resolveDepartment: resolveDeliveryDepartment,
    resolveFlags: () => flags,
    adapters: {
      publish: new PublishChannelAdapter(new DryRunPublishProvider()),
      site_pr: dryRunSitePrAdapter(),
      social: new SocialChannelAdapter(dryRunSocialProvider),
      email: new EmailChannelAdapter(dryRunEspProvider),
    },
    receipts: dbDeliveryReceiptStore,
  });
}

describe("deliverable delivery (#295, real Postgres)", () => {
  it("resolves a real content channel to its department and persists a receipt tied to the approval", async () => {
    const ws = await newWorkspace();
    const channel = await createChannel({ workspaceId: ws.workspaceId, kind: "public", name: "content" });

    // A pending deliverable card (#248) — the #13 row whose approval authorizes the ship.
    const req = await createRequest({
      workspaceId: ws.workspaceId,
      requesterMemberId: ws.memberId,
      actionType: "agent.deliverable",
      payload: { sessionId: newId(), channelId: channel.id, task: "Launch blog post", draft: "Hello, world." },
      amount: null,
      summary: "Deliverable ready for review",
      status: "pending",
      expiresAt: null,
      events: [{ type: "requested", detail: {} }],
    });

    const result = await dispatcher().ship(
      { sessionId: newId(), channelId: channel.id, task: "Launch blog post", draft: "Hello, world." },
      { workspaceId: ws.workspaceId, approvalRequestId: req.id },
    );
    expect(result).toMatchObject({ shipped: true, channel: "publish", provider: "dryrun" });

    const receipts = await listDeliveryReceipts(ws.workspaceId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      approvalRequestId: req.id, // THE proof: the receipt is tied to the #13 approval
      channel: "publish",
      reversibility: "reversible",
      status: "shipped",
      live: false, // dry-run URL is not reachable — honestly recorded, never overclaimed
    });
    expect(receipts[0]?.externalRef).toContain("dryrun.reload.app");
  });

  it("ships a content/SEO deliverable as a site PR when site_pr is on, recording a reversible receipt (#364)", async () => {
    const ws = await newWorkspace();
    const channel = await createChannel({ workspaceId: ws.workspaceId, kind: "public", name: "content" });
    const req = await createRequest({
      workspaceId: ws.workspaceId,
      requesterMemberId: ws.memberId,
      actionType: "agent.deliverable",
      payload: { sessionId: newId(), channelId: channel.id, task: "Homepage SEO copy", draft: "# new copy" },
      amount: null,
      summary: "Deliverable ready for review",
      status: "pending",
      expiresAt: null,
      events: [{ type: "requested", detail: {} }],
    });

    const result = await dispatcher({ ...ALL_ON, site_pr: true }).ship(
      { sessionId: newId(), channelId: channel.id, task: "Homepage SEO copy", draft: "# new copy" },
      { workspaceId: ws.workspaceId, approvalRequestId: req.id },
    );
    // dry-run publisher: a deterministic fake PR url, opened nowhere real → honestly live:false.
    expect(result).toMatchObject({ shipped: true, channel: "site_pr", reversibility: "reversible", live: false });

    const receipts = await listDeliveryReceipts(ws.workspaceId);
    expect(receipts[0]).toMatchObject({
      approvalRequestId: req.id,
      channel: "site_pr",
      reversibility: "reversible",
      status: "shipped",
      live: false,
    });
    expect(receipts[0]?.externalRef).toContain("/pull/");
  });

  it("does not ship a deliverable from a non-department channel (shared room → not shippable)", async () => {
    const ws = await newWorkspace();
    const channel = await createChannel({ workspaceId: ws.workspaceId, kind: "public", name: "general" });
    const result = await dispatcher().ship(
      { channelId: channel.id, task: "x", draft: "y" },
      { workspaceId: ws.workspaceId, approvalRequestId: newId() },
    );
    expect(result).toBeNull();
    expect(await listDeliveryReceipts(ws.workspaceId)).toHaveLength(0);
  });

  it("does not cross tenants: a channel from another workspace resolves to not-shippable", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    const channelB = await createChannel({ workspaceId: b.workspaceId, kind: "public", name: "content" });
    // Workspace A tries to ship using B's channel id → resolveDeliveryDepartment returns null (tenant-scoped).
    const result = await dispatcher().ship(
      { channelId: channelB.id, task: "x", draft: "y" },
      { workspaceId: a.workspaceId, approvalRequestId: newId() },
    );
    expect(result).toBeNull();
  });

  it("countLiveDeliveries counts only genuinely-live receipts (dry-run sends do not inflate it)", async () => {
    const ws = await newWorkspace();
    await dbDeliveryReceiptStore.record({
      workspaceId: ws.workspaceId,
      approvalRequestId: newId(),
      sessionId: null,
      channel: "publish",
      reversibility: "reversible",
      provider: "github_pages",
      live: true,
      externalRef: "https://x.example/live",
      status: "shipped",
      detail: {},
    });
    await dbDeliveryReceiptStore.record({
      workspaceId: ws.workspaceId,
      approvalRequestId: newId(),
      sessionId: null,
      channel: "social",
      reversibility: "irreversible",
      provider: "dryrun",
      live: false,
      externalRef: "dryrun:abc",
      status: "shipped",
      detail: {},
    });
    expect(await countLiveDeliveries(ws.workspaceId)).toBe(1);
  });
});
