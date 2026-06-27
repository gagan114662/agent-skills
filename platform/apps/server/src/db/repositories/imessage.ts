import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../index.js";
import { imessageRecipients } from "../schema/index.js";

export interface IMessageRecipient {
  id: string;
  workspaceId: string;
  memberId: string;
  recipient: string;
  serviceName: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = {
  id: imessageRecipients.id,
  workspaceId: imessageRecipients.workspaceId,
  memberId: imessageRecipients.memberId,
  recipient: imessageRecipients.recipient,
  serviceName: imessageRecipients.serviceName,
  verifiedAt: imessageRecipients.verifiedAt,
  createdAt: imessageRecipients.createdAt,
  updatedAt: imessageRecipients.updatedAt,
} as const;

export async function getIMessageRecipient(
  workspaceId: string,
  memberId: string,
): Promise<IMessageRecipient | undefined> {
  const [row] = await db
    .select(COLUMNS)
    .from(imessageRecipients)
    .where(and(eq(imessageRecipients.workspaceId, workspaceId), eq(imessageRecipients.memberId, memberId)))
    .limit(1);
  return row as IMessageRecipient | undefined;
}

export async function upsertIMessageRecipient(input: {
  workspaceId: string;
  memberId: string;
  recipient: string;
  serviceName?: string | null;
}): Promise<IMessageRecipient> {
  const [row] = await db
    .insert(imessageRecipients)
    .values({
      workspaceId: input.workspaceId,
      memberId: input.memberId,
      recipient: input.recipient,
      serviceName: input.serviceName ?? null,
      verifiedAt: null,
    })
    .onConflictDoUpdate({
      target: [imessageRecipients.workspaceId, imessageRecipients.memberId],
      set: {
        recipient: input.recipient,
        serviceName: input.serviceName ?? null,
        verifiedAt: null,
        updatedAt: sql.raw("now()"),
      },
    })
    .returning(COLUMNS);
  return row as IMessageRecipient;
}

export async function markIMessageRecipientVerified(input: {
  workspaceId: string;
  memberId: string;
  recipient: string;
}): Promise<IMessageRecipient | undefined> {
  const [row] = await db
    .update(imessageRecipients)
    .set({ verifiedAt: sql.raw("now()"), updatedAt: sql.raw("now()") })
    .where(
      and(
        eq(imessageRecipients.workspaceId, input.workspaceId),
        eq(imessageRecipients.memberId, input.memberId),
        eq(imessageRecipients.recipient, input.recipient),
      ),
    )
    .returning(COLUMNS);
  return row as IMessageRecipient | undefined;
}

export async function deleteIMessageRecipient(workspaceId: string, memberId: string): Promise<boolean> {
  const rows = await db
    .delete(imessageRecipients)
    .where(and(eq(imessageRecipients.workspaceId, workspaceId), eq(imessageRecipients.memberId, memberId)))
    .returning({ id: imessageRecipients.id });
  return rows.length > 0;
}

export async function findVerifiedIMessageRecipientByRecipient(input: {
  workspaceId: string;
  recipient: string;
}): Promise<IMessageRecipient | undefined> {
  const [row] = await db
    .select(COLUMNS)
    .from(imessageRecipients)
    .where(
      and(
        eq(imessageRecipients.workspaceId, input.workspaceId),
        eq(imessageRecipients.recipient, input.recipient),
        isNotNull(imessageRecipients.verifiedAt),
      ),
    )
    .limit(1);
  return row as IMessageRecipient | undefined;
}
