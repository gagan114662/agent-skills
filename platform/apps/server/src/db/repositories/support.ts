import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../index.js";
import { newId } from "../id.js";
import { supportKbEntries, supportReceipts } from "../schema/index.js";
import type {
  KbStore,
  ReceiptStore,
  CreateReceiptInput,
  SupportReceipt,
} from "../../support/service.js";
import type { KbEntry } from "../../support/kb.js";

/**
 * Support Desk repository (#190, ADR-0190). Workspace-scoped throughout (the #3 IDOR discipline); the pure
 * routing/kb/sla/recurrence logic lives in `../../support/*` — this is persistence only. Implements the
 * {@link KbStore}/{@link ReceiptStore} seams the {@link SupportDeskService} injects.
 */

const KB_COLS = {
  id: supportKbEntries.id,
  workspaceId: supportKbEntries.workspaceId,
  ventureIdeaId: supportKbEntries.ventureIdeaId,
  slug: supportKbEntries.slug,
  title: supportKbEntries.title,
  body: supportKbEntries.body,
  category: supportKbEntries.category,
  source: supportKbEntries.source,
  sourceTicketId: supportKbEntries.sourceTicketId,
  provenance: supportKbEntries.provenance,
  createdAt: supportKbEntries.createdAt,
  updatedAt: supportKbEntries.updatedAt,
} as const;

export const dbKbStore: KbStore = {
  async list(workspaceId, opts) {
    const filters = [eq(supportKbEntries.workspaceId, workspaceId)];
    if (opts?.category) filters.push(eq(supportKbEntries.category, opts.category));
    const rows = await db
      .select(KB_COLS)
      .from(supportKbEntries)
      .where(and(...filters))
      .orderBy(desc(supportKbEntries.updatedAt));
    return rows as KbEntry[];
  },

  async get(workspaceId, id) {
    const [row] = await db
      .select(KB_COLS)
      .from(supportKbEntries)
      .where(and(eq(supportKbEntries.id, id), eq(supportKbEntries.workspaceId, workspaceId)))
      .limit(1);
    return row as KbEntry | undefined;
  },

  async upsert(input) {
    // Deduped on (workspace, slug): re-distilling the same answer updates it in place rather than
    // duplicating, keeping the KB tidy and the provenance current.
    const inserted = await db
      .insert(supportKbEntries)
      .values({
        id: newId(),
        workspaceId: input.workspaceId,
        ventureIdeaId: input.ventureIdeaId,
        slug: input.slug,
        title: input.title,
        body: input.body,
        category: input.category,
        source: input.source,
        sourceTicketId: input.sourceTicketId,
        provenance: input.provenance,
        createdByMemberId: input.createdByMemberId ?? null,
      })
      .onConflictDoUpdate({
        target: [supportKbEntries.workspaceId, supportKbEntries.slug],
        set: {
          title: input.title,
          body: input.body,
          category: input.category,
          source: input.source,
          sourceTicketId: input.sourceTicketId,
          provenance: input.provenance,
          updatedAt: new Date(),
        },
      })
      .returning(KB_COLS);
    const entry = inserted[0] as KbEntry;
    // `deduped` here means "an existing row was updated" — detectable by created/updated divergence.
    const deduped = entry.createdAt.getTime() !== entry.updatedAt.getTime();
    return { entry, deduped };
  },
};

const RECEIPT_COLS = {
  id: supportReceipts.id,
  workspaceId: supportReceipts.workspaceId,
  ticketId: supportReceipts.ticketId,
  kind: supportReceipts.kind,
  providerRef: supportReceipts.providerRef,
  detail: supportReceipts.detail,
  occurredAt: supportReceipts.occurredAt,
  createdAt: supportReceipts.createdAt,
} as const;

export const dbReceiptStore: ReceiptStore = {
  async create(input: CreateReceiptInput) {
    const inserted = await db
      .insert(supportReceipts)
      .values({
        id: newId(),
        workspaceId: input.workspaceId,
        ticketId: input.ticketId,
        kind: input.kind as (typeof supportReceipts.kind.enumValues)[number],
        providerRef: input.providerRef,
        detail: input.detail ?? null,
        occurredAt: input.occurredAt ?? new Date(),
      })
      // Idempotent on (workspace, ticket, kind, provider_ref). A NULL ticket_id never dedupes (NULLs distinct).
      .onConflictDoNothing({
        target: [
          supportReceipts.workspaceId,
          supportReceipts.ticketId,
          supportReceipts.kind,
          supportReceipts.providerRef,
        ],
      })
      .returning(RECEIPT_COLS);
    if (inserted.length > 0 || input.ticketId === null) {
      return { receipt: inserted[0] as SupportReceipt, deduped: false };
    }
    const [existing] = await db
      .select(RECEIPT_COLS)
      .from(supportReceipts)
      .where(
        and(
          eq(supportReceipts.workspaceId, input.workspaceId),
          eq(supportReceipts.ticketId, input.ticketId),
          eq(supportReceipts.kind, input.kind as (typeof supportReceipts.kind.enumValues)[number]),
          eq(supportReceipts.providerRef, input.providerRef),
        ),
      )
      .limit(1);
    return { receipt: existing as SupportReceipt, deduped: true };
  },

  async listForResolution(workspaceId) {
    const rows = await db
      .select({ ticketId: supportReceipts.ticketId, kind: supportReceipts.kind })
      .from(supportReceipts)
      .where(eq(supportReceipts.workspaceId, workspaceId));
    return rows;
  },

  async listForTicket(workspaceId, ticketId) {
    const rows = await db
      .select(RECEIPT_COLS)
      .from(supportReceipts)
      .where(
        and(eq(supportReceipts.workspaceId, workspaceId), eq(supportReceipts.ticketId, ticketId)),
      )
      .orderBy(supportReceipts.occurredAt);
    return rows as SupportReceipt[];
  },

  async countByKindSince(workspaceId, kind, since) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(supportReceipts)
      .where(
        and(
          eq(supportReceipts.workspaceId, workspaceId),
          eq(supportReceipts.kind, kind as (typeof supportReceipts.kind.enumValues)[number]),
          gte(supportReceipts.occurredAt, since),
        ),
      );
    return row?.count ?? 0;
  },
};
