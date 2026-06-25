import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../index.js";
import {
  firstCustomerStories,
  paymentLinks,
  revenueEvents,
  revenueEvidence,
} from "../schema/index.js";
import { updateWorkspaceBillingContact } from "./workspaces.js";
import type {
  BillingStore,
  CreateEvidenceRow,
  CreateFirstCustomerStoryRow,
  CreatePaymentLinkRow,
  CreateRevenueEventRow,
  FirstCustomerStory,
  PaymentLink,
  RevenueEvent,
  RevenueEvidence,
  RevenueSummary,
} from "../../billing/manager.js";

/**
 * Repository-backed billing store implementing the injectable {@link BillingStore} seam (#98), so the
 * BillingManager persists durably in production while unit tests inject an in-memory store. Reads are
 * **workspace-scoped** to enforce tenant isolation (#9, IDOR-safe). Webhook idempotency is enforced by
 * the unique `(workspace_id, provider_event_id)` constraint; `findRevenueEvent` is the read half of the
 * dedupe check.
 */

const LINK_COLUMNS = {
  id: paymentLinks.id,
  workspaceId: paymentLinks.workspaceId,
  channelId: paymentLinks.channelId,
  sessionId: paymentLinks.sessionId,
  deploymentId: paymentLinks.deploymentId,
  provider: paymentLinks.provider,
  productId: paymentLinks.productId,
  priceId: paymentLinks.priceId,
  providerLinkId: paymentLinks.providerLinkId,
  url: paymentLinks.url,
  amountCents: paymentLinks.amountCents,
  currency: paymentLinks.currency,
  interval: paymentLinks.interval,
  createdByMemberId: paymentLinks.createdByMemberId,
  createdAt: paymentLinks.createdAt,
} as const;

const EVENT_COLUMNS = {
  id: revenueEvents.id,
  workspaceId: revenueEvents.workspaceId,
  channelId: revenueEvents.channelId,
  sessionId: revenueEvents.sessionId,
  deploymentId: revenueEvents.deploymentId,
  provider: revenueEvents.provider,
  providerEventId: revenueEvents.providerEventId,
  type: revenueEvents.type,
  amountCents: revenueEvents.amountCents,
  currency: revenueEvents.currency,
  status: revenueEvents.status,
  trackingRef: revenueEvents.trackingRef,
  raw: revenueEvents.raw,
  createdAt: revenueEvents.createdAt,
} as const;

const FIRST_CUSTOMER_STORY_COLUMNS = {
  id: firstCustomerStories.id,
  workspaceId: firstCustomerStories.workspaceId,
  revenueEventId: firstCustomerStories.revenueEventId,
  channelId: firstCustomerStories.channelId,
  sessionId: firstCustomerStories.sessionId,
  providerEventId: firstCustomerStories.providerEventId,
  amountCents: firstCustomerStories.amountCents,
  currency: firstCustomerStories.currency,
  caseStudyDraft: firstCustomerStories.caseStudyDraft,
  celebrationTitle: firstCustomerStories.celebrationTitle,
  celebrationMessage: firstCustomerStories.celebrationMessage,
  createdAt: firstCustomerStories.createdAt,
} as const;

/** Coerce a selected `revenue_events` row (raw jsonb holds a JSON string) into the domain type. */
function toEvent(row: { raw: unknown } & Record<string, unknown>): RevenueEvent {
  return {
    ...(row as unknown as RevenueEvent),
    raw: typeof row.raw === "string" ? row.raw : JSON.stringify(row.raw ?? {}),
  };
}

export const dbBillingStore: BillingStore = {
  async createPaymentLink(input: CreatePaymentLinkRow): Promise<PaymentLink> {
    const [row] = await db.insert(paymentLinks).values(input).returning(LINK_COLUMNS);
    return row as PaymentLink;
  },

  async findRevenueEvent(
    workspaceId: string,
    providerEventId: string,
  ): Promise<RevenueEvent | undefined> {
    const [row] = await db
      .select(EVENT_COLUMNS)
      .from(revenueEvents)
      .where(
        and(
          eq(revenueEvents.workspaceId, workspaceId),
          eq(revenueEvents.providerEventId, providerEventId),
        ),
      )
      .limit(1);
    return row ? toEvent(row) : undefined;
  },

  async createRevenueEvent(input: CreateRevenueEventRow): Promise<RevenueEvent> {
    const [row] = await db
      .insert(revenueEvents)
      .values({ ...input, raw: input.raw })
      .returning(EVENT_COLUMNS);
    return toEvent(row!);
  },

  async updateWorkspaceBillingContact(input): Promise<unknown> {
    return updateWorkspaceBillingContact(input);
  },

  async createEvidence(input: CreateEvidenceRow): Promise<RevenueEvidence> {
    const [row] = await db.insert(revenueEvidence).values(input).returning({
      id: revenueEvidence.id,
      workspaceId: revenueEvidence.workspaceId,
      sessionId: revenueEvidence.sessionId,
      kind: revenueEvidence.kind,
      source: revenueEvidence.source,
      revenueEventId: revenueEvidence.revenueEventId,
      amountCents: revenueEvidence.amountCents,
      currency: revenueEvidence.currency,
      summary: revenueEvidence.summary,
      createdAt: revenueEvidence.createdAt,
    });
    return row as RevenueEvidence;
  },

  async createFirstCustomerStory(
    input: CreateFirstCustomerStoryRow,
  ): Promise<FirstCustomerStory | undefined> {
    const [row] = await db
      .insert(firstCustomerStories)
      .values(input)
      .onConflictDoNothing({ target: firstCustomerStories.workspaceId })
      .returning(FIRST_CUSTOMER_STORY_COLUMNS);
    return row as FirstCustomerStory | undefined;
  },

  async revenueSummary(workspaceId: string, limit = 10): Promise<RevenueSummary> {
    const [totals] = await db
      .select({
        totalCents: sql<number>`coalesce(sum(${revenueEvents.amountCents}), 0)::int`,
        paymentCount: sql<number>`count(*)::int`,
      })
      .from(revenueEvents)
      .where(eq(revenueEvents.workspaceId, workspaceId));
    const [evidenceCountRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(revenueEvidence)
      .where(eq(revenueEvidence.workspaceId, workspaceId));
    const recentRows = await db
      .select(EVENT_COLUMNS)
      .from(revenueEvents)
      .where(eq(revenueEvents.workspaceId, workspaceId))
      .orderBy(desc(revenueEvents.createdAt))
      .limit(limit);
    const recent = recentRows.map(toEvent);
    return {
      currency: recent[0]?.currency ?? "usd",
      totalCents: totals?.totalCents ?? 0,
      paymentCount: totals?.paymentCount ?? 0,
      evidenceCount: evidenceCountRow?.n ?? 0,
      recent,
    };
  },
};
