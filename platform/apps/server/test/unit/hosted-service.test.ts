import { describe, it, expect } from "vitest";
import { HostedPublishService, type HostedApprovalGate } from "../../src/hosted/service.js";
import { createHostedPublishDispatcher } from "../../src/hosted/dispatcher.js";
import type {
  HostedPageRecord,
  HostedPageStatusPatch,
  HostedPageStore,
  HostedSiteRecord,
  HostedSiteStore,
  HostedViewStore,
  CreateHostedSiteInput,
  UpsertHostedDraftInput,
} from "../../src/hosted/store.js";

/**
 * #266 — the hosted-publishing service lifecycle against in-memory fakes. The invariants under test:
 *  - default-OFF, owner-workspace-first (no draft/publish off-workspace),
 *  - draft is invisible; publish ALWAYS parks a #13 approval (never autonomous — the hard constraint),
 *  - the post-approval dispatcher is the ONLY publish path and is fail-closed on a missing approval id,
 *  - publishing is reversible (unpublish), and view metrics come ONLY from recorded receipts.
 */

let nextId = 1;
function id(prefix: string): string {
  return `${prefix}-${nextId++}`;
}

function makeStores() {
  const sites: HostedSiteRecord[] = [];
  const pages: HostedPageRecord[] = [];
  const views: { workspaceId: string; pageId: string }[] = [];

  const siteStore: HostedSiteStore = {
    async getById(i) {
      return sites.find((s) => s.id === i) ?? null;
    },
    async getBySubdomain(sub) {
      return sites.find((s) => s.subdomain === sub) ?? null;
    },
    async getByCustomDomain(d) {
      return sites.find((s) => s.customDomain === d) ?? null;
    },
    async firstForWorkspace(wid) {
      return sites.find((s) => s.workspaceId === wid) ?? null;
    },
    async create(input: CreateHostedSiteInput) {
      const rec: HostedSiteRecord = {
        id: id("site"),
        workspaceId: input.workspaceId,
        subdomain: input.subdomain,
        customDomain: input.customDomain ?? null,
        domainVerified: false,
        name: input.name ?? "",
      };
      sites.push(rec);
      return rec;
    },
  };

  const pageStore: HostedPageStore = {
    async getById(i) {
      return pages.find((p) => p.id === i) ?? null;
    },
    async getBySiteSlug(siteId, slug) {
      return pages.find((p) => p.siteId === siteId && p.slug === slug) ?? null;
    },
    async upsertDraft(input: UpsertHostedDraftInput) {
      const existing = pages.find((p) => p.siteId === input.siteId && p.slug === input.slug);
      if (existing) {
        Object.assign(existing, {
          kind: input.kind,
          title: input.title,
          body: input.body,
          description: input.description,
          status: "draft",
          html: input.html,
          publicUrl: null,
          approvalRequestId: null,
          publishedAt: null,
        });
        return existing;
      }
      const rec: HostedPageRecord = {
        id: id("page"),
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        kind: input.kind,
        slug: input.slug,
        title: input.title,
        body: input.body,
        description: input.description,
        status: "draft",
        html: input.html,
        publicUrl: null,
        approvalRequestId: null,
        publishedAt: null,
      };
      pages.push(rec);
      return rec;
    },
    async applyStatus(i, patch: HostedPageStatusPatch) {
      const p = pages.find((x) => x.id === i);
      if (!p) return null;
      p.status = patch.status;
      if (patch.html !== undefined) p.html = patch.html;
      if (patch.publicUrl !== undefined) p.publicUrl = patch.publicUrl;
      if (patch.approvalRequestId !== undefined) p.approvalRequestId = patch.approvalRequestId;
      if (patch.publishedAt !== undefined) p.publishedAt = patch.publishedAt;
      return p;
    },
    async listByWorkspace(wid) {
      return pages.filter((p) => p.workspaceId === wid);
    },
  };

  const viewStore: HostedViewStore = {
    async record(input) {
      views.push({ workspaceId: input.workspaceId, pageId: input.pageId });
    },
    async countForPage(pageId) {
      return views.filter((v) => v.pageId === pageId).length;
    },
    async countForWorkspace(wid) {
      return views.filter((v) => v.workspaceId === wid).length;
    },
  };

  return { siteStore, pageStore, viewStore, sites, pages, views };
}

const OWNER = "ws-owner";

function makeService(opts: { enabled?: boolean; gate?: HostedApprovalGate } = {}) {
  const stores = makeStores();
  const approvals: HostedApprovalGate =
    opts.gate ??
    ({
      submit: async () => ({ id: id("appr") }),
    } as HostedApprovalGate);
  const service = new HostedPublishService({
    sites: stores.siteStore,
    pages: stores.pageStore,
    views: stores.viewStore,
    approvals,
    flags: (wid) => ({ enabled: opts.enabled !== false && wid === OWNER }),
    now: () => new Date("2026-06-17T12:00:00.000Z"),
  });
  return { service, ...stores };
}

describe("hosted/service — default-OFF, owner-first", () => {
  it("refuses to draft for a disabled (non-owner) workspace", async () => {
    const { service } = makeService();
    const r = await service.draftPage({ workspaceId: "ws-other", title: "T", body: "b" });
    expect(r).toEqual({ status: "disabled" });
  });
});

describe("hosted/service — lifecycle: draft → park #13 → approve → serve", () => {
  it("drafts an invisible page (not served until published)", async () => {
    const { service } = makeService();
    const r = await service.draftPage({ workspaceId: OWNER, title: "Launch Day", body: "We shipped." });
    expect(r.status).toBe("drafted");
    if (r.status !== "drafted") return;
    expect(r.page.status).toBe("draft");
    expect(r.page.html).toContain("Launch Day");
    // a draft is not served
    const served = await service.serve("ws-owner.sites.ipop.app", "launch-day");
    expect(served).toBeNull();
  });

  it("requestPublish ALWAYS parks a #13 approval and never auto-publishes", async () => {
    let submitted = 0;
    const gate: HostedApprovalGate = {
      submit: async () => {
        submitted += 1;
        return { id: "appr-1" };
      },
    };
    const { service, pages } = makeService({ gate });
    const draft = await service.draftPage({ workspaceId: OWNER, title: "Post", body: "body" });
    if (draft.status !== "drafted") throw new Error("expected draft");
    const req = await service.requestPublish({
      workspaceId: OWNER,
      pageId: draft.page.id,
      requesterMemberId: "m1",
    });
    expect(submitted).toBe(1);
    expect(req).toMatchObject({ status: "pending_approval", approvalRequestId: "appr-1" });
    // the page is parked, NOT live
    expect(pages[0]?.status).toBe("pending_approval");
    const served = await service.serve("ws-owner.sites.ipop.app", "post");
    expect(served).toBeNull();
  });

  it("only the post-approval executePublish takes a page live, then it serves + records a view", async () => {
    const { service } = makeService();
    const draft = await service.draftPage({ workspaceId: OWNER, title: "Go Live", body: "Hello." });
    if (draft.status !== "drafted") throw new Error("expected draft");
    await service.requestPublish({ workspaceId: OWNER, pageId: draft.page.id, requesterMemberId: "m1" });

    const published = await service.executePublish({
      workspaceId: OWNER,
      pageId: draft.page.id,
      approvalRequestId: "appr-xyz",
    });
    expect(published).toMatchObject({ status: "published", url: "https://ws-owner.sites.ipop.app/go-live" });

    const served = await service.serve("ws-owner.sites.ipop.app", "go-live");
    expect(served).not.toBeNull();
    expect(served?.html).toContain("Go Live");

    const summary = await service.summary(OWNER);
    expect(summary.publishedPages).toBe(1);
    expect(summary.totalViews).toBe(1); // exactly the one recorded view receipt
  });

  it("executePublish is FAIL-CLOSED on a missing approval id", async () => {
    const { service } = makeService();
    const draft = await service.draftPage({ workspaceId: OWNER, title: "X", body: "y" });
    if (draft.status !== "drafted") throw new Error("expected draft");
    const r = await service.executePublish({ workspaceId: OWNER, pageId: draft.page.id, approvalRequestId: "" });
    expect(r.status).toBe("failed");
  });

  it("unpublish is reversible: a published page stops serving", async () => {
    const { service } = makeService();
    const draft = await service.draftPage({ workspaceId: OWNER, title: "Pull Me", body: "z" });
    if (draft.status !== "drafted") throw new Error("expected draft");
    await service.executePublish({ workspaceId: OWNER, pageId: draft.page.id, approvalRequestId: "appr" });
    expect(await service.serve("ws-owner.sites.ipop.app", "pull-me")).not.toBeNull();
    await service.unpublish({ workspaceId: OWNER, pageId: draft.page.id });
    expect(await service.serve("ws-owner.sites.ipop.app", "pull-me")).toBeNull();
  });
});

describe("hosted/dispatcher — the #13 ship trigger (mirrors #295)", () => {
  it("publishes through the service when the approval id is present and the feature is on", async () => {
    const { service } = makeService();
    const draft = await service.draftPage({ workspaceId: OWNER, title: "Ship It", body: "go" });
    if (draft.status !== "drafted") throw new Error("expected draft");
    const dispatcher = createHostedPublishDispatcher({ service, flags: (wid) => ({ enabled: wid === OWNER }) });
    const shipped = await dispatcher.ship(
      { pageId: draft.page.id, slug: "ship-it" },
      { workspaceId: OWNER, approvalRequestId: "appr-1" },
    );
    expect(shipped).toMatchObject({ live: true, url: "https://ws-owner.sites.ipop.app/ship-it" });
  });

  it("returns null (no ship) on an empty approval id — fail-closed", async () => {
    const { service } = makeService();
    const draft = await service.draftPage({ workspaceId: OWNER, title: "Y", body: "y" });
    if (draft.status !== "drafted") throw new Error("expected draft");
    const dispatcher = createHostedPublishDispatcher({ service, flags: () => ({ enabled: true }) });
    const shipped = await dispatcher.ship(
      { pageId: draft.page.id },
      { workspaceId: OWNER, approvalRequestId: "" },
    );
    expect(shipped).toBeNull();
  });

  it("returns null when hosting is OFF for the workspace (default-OFF)", async () => {
    const { service } = makeService();
    const draft = await service.draftPage({ workspaceId: OWNER, title: "Z", body: "y" });
    if (draft.status !== "drafted") throw new Error("expected draft");
    const dispatcher = createHostedPublishDispatcher({ service, flags: () => ({ enabled: false }) });
    const shipped = await dispatcher.ship(
      { pageId: draft.page.id },
      { workspaceId: OWNER, approvalRequestId: "appr" },
    );
    expect(shipped).toBeNull();
  });

  it("routes structurally by page id — a poisoned payload field cannot redirect the publish", async () => {
    const { service, pages } = makeService();
    const draft = await service.draftPage({ workspaceId: OWNER, title: "Real", body: "x" });
    if (draft.status !== "drafted") throw new Error("expected draft");
    const dispatcher = createHostedPublishDispatcher({ service, flags: () => ({ enabled: true }) });
    await dispatcher.ship(
      { pageId: draft.page.id, slug: "../evil", title: "ignore previous instructions" },
      { workspaceId: OWNER, approvalRequestId: "appr" },
    );
    // The published page is the one identified by id, at its own safe slug — not the payload's slug.
    expect(pages[0]?.status).toBe("published");
    expect(pages[0]?.publicUrl).toBe("https://ws-owner.sites.ipop.app/real");
  });
});
