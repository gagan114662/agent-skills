import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../index.js";
import { hostedSites, hostedPages, hostedPageViews } from "../schema/index.js";
import type { HostedPageKind, HostedPageStatus } from "../../hosted/decide.js";
import type {
  CreateHostedSiteInput,
  HostedPageRecord,
  HostedPageStatusPatch,
  HostedPageStore,
  HostedSiteRecord,
  HostedSiteStore,
  HostedViewStore,
  UpsertHostedDraftInput,
} from "../../hosted/store.js";

/**
 * #266 hosted-publishing repositories. Tenant-scoped throughout (#3 — every write carries workspace_id and
 * the FK cascades on workspace delete). The repos implement the {@link HostedSiteStore}/{@link HostedPageStore}/
 * {@link HostedViewStore} seams the service writes through; the in-memory fakes in the unit tests prove the
 * service logic without a DB.
 */

type SiteRow = typeof hostedSites.$inferSelect;
type PageRow = typeof hostedPages.$inferSelect;

function toSite(r: SiteRow): HostedSiteRecord {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    subdomain: r.subdomain,
    customDomain: r.customDomain,
    domainVerified: r.domainVerified,
    name: r.name,
  };
}

function toPage(r: PageRow): HostedPageRecord {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    siteId: r.siteId,
    kind: r.kind as HostedPageKind,
    slug: r.slug,
    title: r.title,
    body: r.body,
    description: r.description,
    status: r.status as HostedPageStatus,
    html: r.html,
    publicUrl: r.publicUrl,
    approvalRequestId: r.approvalRequestId,
    publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
  };
}

export const dbHostedSiteStore: HostedSiteStore = {
  async getById(id) {
    const [row] = await db.select().from(hostedSites).where(eq(hostedSites.id, id)).limit(1);
    return row ? toSite(row) : null;
  },
  async getBySubdomain(subdomain) {
    const [row] = await db
      .select()
      .from(hostedSites)
      .where(eq(hostedSites.subdomain, subdomain))
      .limit(1);
    return row ? toSite(row) : null;
  },
  async getByCustomDomain(domain) {
    const [row] = await db
      .select()
      .from(hostedSites)
      .where(eq(hostedSites.customDomain, domain))
      .limit(1);
    return row ? toSite(row) : null;
  },
  async firstForWorkspace(workspaceId) {
    const [row] = await db
      .select()
      .from(hostedSites)
      .where(eq(hostedSites.workspaceId, workspaceId))
      .orderBy(hostedSites.createdAt)
      .limit(1);
    return row ? toSite(row) : null;
  },
  async create(input: CreateHostedSiteInput) {
    const [row] = await db
      .insert(hostedSites)
      .values({
        workspaceId: input.workspaceId,
        subdomain: input.subdomain,
        customDomain: input.customDomain ?? null,
        name: input.name ?? "",
      })
      .returning();
    return toSite(row!);
  },
};

export const dbHostedPageStore: HostedPageStore = {
  async getById(id) {
    const [row] = await db.select().from(hostedPages).where(eq(hostedPages.id, id)).limit(1);
    return row ? toPage(row) : null;
  },
  async getBySiteSlug(siteId, slug) {
    const [row] = await db
      .select()
      .from(hostedPages)
      .where(and(eq(hostedPages.siteId, siteId), eq(hostedPages.slug, slug)))
      .limit(1);
    return row ? toPage(row) : null;
  },
  async upsertDraft(input: UpsertHostedDraftInput) {
    const [row] = await db
      .insert(hostedPages)
      .values({
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        kind: input.kind,
        slug: input.slug,
        title: input.title,
        body: input.body,
        description: input.description,
        status: "draft",
        html: input.html,
      })
      .onConflictDoUpdate({
        target: [hostedPages.siteId, hostedPages.slug],
        set: {
          kind: input.kind,
          title: input.title,
          body: input.body,
          description: input.description,
          status: "draft",
          html: input.html,
          publicUrl: null,
          approvalRequestId: null,
          publishedAt: null,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return toPage(row!);
  },
  async applyStatus(id, patch: HostedPageStatusPatch) {
    const set: Record<string, unknown> = { status: patch.status, updatedAt: sql`now()` };
    if (patch.html !== undefined) set.html = patch.html;
    if (patch.publicUrl !== undefined) set.publicUrl = patch.publicUrl;
    if (patch.approvalRequestId !== undefined) set.approvalRequestId = patch.approvalRequestId;
    if (patch.publishedAt !== undefined) {
      set.publishedAt = patch.publishedAt ? new Date(patch.publishedAt) : null;
    }
    const [row] = await db
      .update(hostedPages)
      .set(set)
      .where(eq(hostedPages.id, id))
      .returning();
    return row ? toPage(row) : null;
  },
  async listByWorkspace(workspaceId, limit = 50) {
    const rows = await db
      .select()
      .from(hostedPages)
      .where(eq(hostedPages.workspaceId, workspaceId))
      .orderBy(desc(hostedPages.updatedAt))
      .limit(limit);
    return rows.map(toPage);
  },
};

export const dbHostedViewStore: HostedViewStore = {
  async record(input) {
    await db.insert(hostedPageViews).values({
      workspaceId: input.workspaceId,
      pageId: input.pageId,
      referrer: input.referrer ?? null,
    });
  },
  async countForPage(pageId) {
    const rows = await db
      .select({ id: hostedPageViews.id })
      .from(hostedPageViews)
      .where(eq(hostedPageViews.pageId, pageId));
    return rows.length;
  },
  async countForWorkspace(workspaceId) {
    const rows = await db
      .select({ id: hostedPageViews.id })
      .from(hostedPageViews)
      .where(eq(hostedPageViews.workspaceId, workspaceId));
    return rows.length;
  },
};
