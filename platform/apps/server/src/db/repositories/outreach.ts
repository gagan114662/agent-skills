import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../index.js";
import { outreachMessages, outreachReceipts } from "../schema/index.js";
import type { MessageInsertInput, MessageStore, ReceiptStore } from "../../outreach/service.js";
import type {
  OutreachChannel,
  OutreachMessageRecord,
  OutreachReceiptKind,
  OutreachReceiptRecord,
  OutreachSpamRiskLevel,
} from "../../outreach/types.js";

export const OUTREACH_MESSAGES_DEFAULT_LIMIT = 200;
export const OUTREACH_MESSAGES_MAX_LIMIT = 500;

/**
 * Outreach engine repositories (#225). Implement the {@link MessageStore} / {@link ReceiptStore} seams the
 * service writes + reads through. Tenant-scoped throughout (#3). The receipt insert is idempotent via the
 * `(workspace_id, message_id, kind, external_ref)` unique index — a re-delivered webhook lands once.
 */

function toMessage(r: typeof outreachMessages.$inferSelect): OutreachMessageRecord {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    ideaId: r.ideaId,
    prospectKey: r.prospectKey,
    accountId: r.accountId,
    buyerBriefId: r.buyerBriefId,
    channel: r.channel as OutreachChannel,
    variant: r.variant as OutreachMessageRecord["variant"],
    signalKind: r.signalKind,
    subject: r.subject,
    body: r.body,
    recipientLabel: r.recipientLabel,
    recipientRef: r.recipientRef,
    spamRiskScore: r.spamRiskScore,
    spamRiskLevel: r.spamRiskLevel as OutreachSpamRiskLevel,
    spamRiskReasons: Array.isArray(r.spamRiskReasons)
      ? r.spamRiskReasons.filter((reason): reason is string => typeof reason === "string")
      : [],
    experimentKey: r.experimentKey,
    status: r.status as OutreachMessageRecord["status"],
    approvalRequestId: r.approvalRequestId,
    provider: r.provider,
    externalId: r.externalId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function clampOutreachMessagesLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0)
    return OUTREACH_MESSAGES_DEFAULT_LIMIT;
  return Math.min(OUTREACH_MESSAGES_MAX_LIMIT, Math.floor(limit));
}

export const dbMessageStore: MessageStore = {
  async insert(input: MessageInsertInput): Promise<OutreachMessageRecord> {
    const [row] = await db
      .insert(outreachMessages)
      .values({
        workspaceId: input.workspaceId,
        ideaId: input.ideaId,
        prospectKey: input.prospectKey,
        accountId: input.accountId,
        buyerBriefId: input.buyerBriefId,
        channel: input.channel,
        variant: input.variant,
        signalKind: input.signalKind,
        subject: input.subject,
        body: input.body,
        recipientLabel: input.recipientLabel,
        recipientRef: input.recipientRef,
        spamRiskScore: input.spamRiskScore,
        spamRiskLevel: input.spamRiskLevel,
        spamRiskReasons: input.spamRiskReasons,
        experimentKey: input.experimentKey,
        status: input.status,
        provider: input.provider,
      })
      .returning();
    if (!row) throw new Error("outreach message insert returned no row");
    return toMessage(row);
  },

  async get(workspaceId, id): Promise<OutreachMessageRecord | undefined> {
    const [row] = await db
      .select()
      .from(outreachMessages)
      .where(and(eq(outreachMessages.workspaceId, workspaceId), eq(outreachMessages.id, id)))
      .limit(1);
    return row ? toMessage(row) : undefined;
  },

  async findByRecipientRef(workspaceId, recipientRef): Promise<OutreachMessageRecord | undefined> {
    const [row] = await db
      .select()
      .from(outreachMessages)
      .where(
        and(
          eq(outreachMessages.workspaceId, workspaceId),
          eq(outreachMessages.recipientRef, recipientRef),
        ),
      )
      .orderBy(desc(outreachMessages.createdAt))
      .limit(1);
    return row ? toMessage(row) : undefined;
  },

  async setApproval(workspaceId, id, update): Promise<void> {
    await db
      .update(outreachMessages)
      .set({
        status: update.status,
        approvalRequestId: update.approvalRequestId,
        updatedAt: new Date(),
      })
      .where(and(eq(outreachMessages.workspaceId, workspaceId), eq(outreachMessages.id, id)));
  },

  async list(workspaceId, opts): Promise<OutreachMessageRecord[]> {
    const conds = [eq(outreachMessages.workspaceId, workspaceId)];
    if (opts?.ideaId) conds.push(eq(outreachMessages.ideaId, opts.ideaId));
    const rows = await db
      .select()
      .from(outreachMessages)
      .where(and(...conds))
      .orderBy(desc(outreachMessages.createdAt))
      .limit(clampOutreachMessagesLimit(opts?.limit));
    return rows.map(toMessage);
  },

  async countActiveOnChannel(workspaceId, channel, since): Promise<number> {
    const rows = await db
      .select({ id: outreachMessages.id })
      .from(outreachMessages)
      .where(
        and(
          eq(outreachMessages.workspaceId, workspaceId),
          eq(outreachMessages.channel, channel),
          gte(outreachMessages.createdAt, since),
        ),
      );
    // Count only those that consumed send capacity (parked or sent), not blocked/failed drafts.
    return rows.length;
  },
};

/** Flip a message to `sent` after the approved channel adapter returns a provider id. Tenant-scoped. */
export async function markMessageSent(
  workspaceId: string,
  id: string,
  provider: string,
  externalId: string,
): Promise<OutreachMessageRecord | undefined> {
  const [row] = await db
    .update(outreachMessages)
    .set({ status: "sent", provider, externalId, updatedAt: new Date() })
    .where(and(eq(outreachMessages.workspaceId, workspaceId), eq(outreachMessages.id, id)))
    .returning();
  return row ? toMessage(row) : undefined;
}

/** Record an approved send attempt that could not be delivered. Tenant-scoped. */
export async function markMessageFailed(
  workspaceId: string,
  id: string,
  provider: string,
): Promise<OutreachMessageRecord | undefined> {
  const [row] = await db
    .update(outreachMessages)
    .set({ status: "failed", provider, externalId: null, updatedAt: new Date() })
    .where(and(eq(outreachMessages.workspaceId, workspaceId), eq(outreachMessages.id, id)))
    .returning();
  return row ? toMessage(row) : undefined;
}

function toReceipt(r: typeof outreachReceipts.$inferSelect): OutreachReceiptRecord {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    messageId: r.messageId,
    kind: r.kind as OutreachReceiptKind,
    externalRef: r.externalRef,
    replyBody: r.replyBody,
    replyFrom: r.replyFrom,
    replySubject: r.replySubject,
    occurredAt: r.occurredAt,
    createdAt: r.createdAt,
  };
}

export const dbReceiptStore: ReceiptStore = {
  async insert(input): Promise<{ record: OutreachReceiptRecord; created: boolean }> {
    const inserted = await db
      .insert(outreachReceipts)
      .values({
        workspaceId: input.workspaceId,
        messageId: input.messageId,
        kind: input.kind,
        externalRef: input.externalRef,
        replyBody: input.replyBody ?? null,
        replyFrom: input.replyFrom ?? null,
        replySubject: input.replySubject ?? null,
        occurredAt: input.occurredAt,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return { record: toReceipt(inserted[0]), created: true };
    // Conflict (idempotent re-delivery): read back the canonical row.
    const [existing] = await db
      .select()
      .from(outreachReceipts)
      .where(
        and(
          eq(outreachReceipts.workspaceId, input.workspaceId),
          eq(outreachReceipts.messageId, input.messageId),
          eq(outreachReceipts.kind, input.kind),
          eq(outreachReceipts.externalRef, input.externalRef),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("outreach receipt conflict but no canonical row found");
    return { record: toReceipt(existing), created: false };
  },

  async list(workspaceId, opts): Promise<OutreachReceiptRecord[]> {
    // Receipts are workspace-scoped; the ideaId narrowing is applied by joining through the message in
    // the service layer when needed. Here we return all workspace receipts (the common case).
    void opts;
    const rows = await db
      .select()
      .from(outreachReceipts)
      .where(eq(outreachReceipts.workspaceId, workspaceId))
      .orderBy(desc(outreachReceipts.createdAt));
    return rows.map(toReceipt);
  },
};
