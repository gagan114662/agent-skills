import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db, getPool } from "../index.js";
import {
  imessageRecipients,
  imessageRelayHeartbeats,
  imessageRelayInboundReceipts,
  imessageRelayJobs,
} from "../schema/index.js";

export type IMessageRelayJobPurpose = "verification" | "room" | "notification";
export type IMessageRelayJobStatus = "pending" | "claimed" | "sent" | "failed";

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

export interface IMessageRelayJob {
  id: string;
  workspaceId: string;
  memberId: string | null;
  channelId: string | null;
  messageId: string | null;
  purpose: IMessageRelayJobPurpose;
  recipient: string;
  serviceName: string | null;
  body: string;
  receipt: string | null;
  status: IMessageRelayJobStatus;
  lockedBy: string | null;
  lockedUntil: Date | null;
  sentAt: Date | null;
  failedAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IMessageRelayHeartbeat {
  relayId: string;
  host: string;
  version: string | null;
  checkedInAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IMessageRelayInboundReceipt {
  id: string;
  workspaceId: string;
  memberId: string;
  channelId: string;
  messageId: string;
  replyToMessageId: string;
  sender: string;
  receipt: string;
  text: string;
  createdAt: Date;
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

const JOB_COLUMNS = {
  id: imessageRelayJobs.id,
  workspaceId: imessageRelayJobs.workspaceId,
  memberId: imessageRelayJobs.memberId,
  channelId: imessageRelayJobs.channelId,
  messageId: imessageRelayJobs.messageId,
  purpose: imessageRelayJobs.purpose,
  recipient: imessageRelayJobs.recipient,
  serviceName: imessageRelayJobs.serviceName,
  body: imessageRelayJobs.body,
  receipt: imessageRelayJobs.receipt,
  status: imessageRelayJobs.status,
  lockedBy: imessageRelayJobs.lockedBy,
  lockedUntil: imessageRelayJobs.lockedUntil,
  sentAt: imessageRelayJobs.sentAt,
  failedAt: imessageRelayJobs.failedAt,
  error: imessageRelayJobs.error,
  createdAt: imessageRelayJobs.createdAt,
  updatedAt: imessageRelayJobs.updatedAt,
} as const;

const HEARTBEAT_COLUMNS = {
  relayId: imessageRelayHeartbeats.relayId,
  host: imessageRelayHeartbeats.host,
  version: imessageRelayHeartbeats.version,
  checkedInAt: imessageRelayHeartbeats.checkedInAt,
  createdAt: imessageRelayHeartbeats.createdAt,
  updatedAt: imessageRelayHeartbeats.updatedAt,
} as const;

const INBOUND_RECEIPT_COLUMNS = {
  id: imessageRelayInboundReceipts.id,
  workspaceId: imessageRelayInboundReceipts.workspaceId,
  memberId: imessageRelayInboundReceipts.memberId,
  channelId: imessageRelayInboundReceipts.channelId,
  messageId: imessageRelayInboundReceipts.messageId,
  replyToMessageId: imessageRelayInboundReceipts.replyToMessageId,
  sender: imessageRelayInboundReceipts.sender,
  receipt: imessageRelayInboundReceipts.receipt,
  text: imessageRelayInboundReceipts.text,
  createdAt: imessageRelayInboundReceipts.createdAt,
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

export async function enqueueIMessageRelayJob(input: {
  workspaceId: string;
  memberId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  purpose: IMessageRelayJobPurpose;
  recipient: string;
  serviceName?: string | null;
  body: string;
  receipt?: string | null;
}): Promise<IMessageRelayJob> {
  const [row] = await db
    .insert(imessageRelayJobs)
    .values({
      workspaceId: input.workspaceId,
      memberId: input.memberId ?? null,
      channelId: input.channelId ?? null,
      messageId: input.messageId ?? null,
      purpose: input.purpose,
      recipient: input.recipient,
      serviceName: input.serviceName ?? null,
      body: input.body,
      receipt: input.receipt ?? null,
    })
    .returning(JOB_COLUMNS);
  return row as IMessageRelayJob;
}

export async function claimIMessageRelayJobs(input: {
  relayId: string;
  limit: number;
  leaseMs: number;
  nowMs?: number;
}): Promise<IMessageRelayJob[]> {
  const limit = Math.max(1, Math.min(25, Math.floor(input.limit)));
  const now = new Date(input.nowMs ?? Date.now());
  const lockedUntil = new Date(now.getTime() + Math.max(1_000, input.leaseMs));
  const result = await getPool().query(
    `
      UPDATE imessage_relay_jobs
         SET status = 'claimed',
             locked_by = $1,
             locked_until = $2,
             updated_at = $3
       WHERE id IN (
         SELECT id
           FROM imessage_relay_jobs
          WHERE status = 'pending'
             OR (status = 'claimed' AND (locked_until IS NULL OR locked_until <= $3))
          ORDER BY created_at ASC
          LIMIT $4
          FOR UPDATE SKIP LOCKED
       )
       RETURNING id, workspace_id, member_id, channel_id, message_id, purpose, recipient, service_name,
                 body, receipt, status, locked_by, locked_until, sent_at, failed_at, error, created_at, updated_at
    `,
    [input.relayId, lockedUntil, now, limit],
  );
  return result.rows.map(rowToRelayJob);
}

export async function completeIMessageRelayJob(input: {
  id: string;
  relayId: string;
  status: "sent" | "failed";
  error?: string | null;
  nowMs?: number;
}): Promise<IMessageRelayJob | undefined> {
  const now = new Date(input.nowMs ?? Date.now());
  const [row] = await db
    .update(imessageRelayJobs)
    .set({
      status: input.status,
      sentAt: input.status === "sent" ? now : null,
      failedAt: input.status === "failed" ? now : null,
      error: input.status === "failed" ? input.error ?? "relay send failed" : null,
      lockedBy: null,
      lockedUntil: null,
      updatedAt: now,
    })
    .where(and(eq(imessageRelayJobs.id, input.id), eq(imessageRelayJobs.lockedBy, input.relayId)))
    .returning(JOB_COLUMNS);
  return row as IMessageRelayJob | undefined;
}

export async function getIMessageRelayJob(id: string): Promise<IMessageRelayJob | undefined> {
  const [row] = await db.select(JOB_COLUMNS).from(imessageRelayJobs).where(eq(imessageRelayJobs.id, id)).limit(1);
  return row as IMessageRelayJob | undefined;
}

export async function getLatestIMessageRelayJobForMember(input: {
  workspaceId: string;
  memberId: string;
}): Promise<IMessageRelayJob | undefined> {
  const [row] = await db
    .select(JOB_COLUMNS)
    .from(imessageRelayJobs)
    .where(and(eq(imessageRelayJobs.workspaceId, input.workspaceId), eq(imessageRelayJobs.memberId, input.memberId)))
    .orderBy(desc(imessageRelayJobs.createdAt))
    .limit(1);
  return row as IMessageRelayJob | undefined;
}

export async function recordIMessageRelayHeartbeat(input: {
  relayId: string;
  host: string;
  version?: string | null;
  nowMs?: number;
}): Promise<IMessageRelayHeartbeat> {
  const now = new Date(input.nowMs ?? Date.now());
  const [row] = await db
    .insert(imessageRelayHeartbeats)
    .values({
      relayId: input.relayId,
      host: input.host,
      version: input.version ?? null,
      checkedInAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: imessageRelayHeartbeats.relayId,
      set: {
        host: input.host,
        version: input.version ?? null,
        checkedInAt: now,
        updatedAt: now,
      },
    })
    .returning(HEARTBEAT_COLUMNS);
  return row as IMessageRelayHeartbeat;
}

export async function getLatestIMessageRelayHeartbeat(): Promise<IMessageRelayHeartbeat | undefined> {
  const [row] = await db
    .select(HEARTBEAT_COLUMNS)
    .from(imessageRelayHeartbeats)
    .orderBy(desc(imessageRelayHeartbeats.checkedInAt))
    .limit(1);
  return row as IMessageRelayHeartbeat | undefined;
}

export async function recordIMessageRelayInboundReceipt(input: {
  workspaceId: string;
  memberId: string;
  channelId: string;
  messageId: string;
  replyToMessageId: string;
  sender: string;
  receipt: string;
  text: string;
}): Promise<IMessageRelayInboundReceipt> {
  const [row] = await db
    .insert(imessageRelayInboundReceipts)
    .values(input)
    .onConflictDoUpdate({
      target: imessageRelayInboundReceipts.messageId,
      set: {
        sender: input.sender,
        receipt: input.receipt,
        text: input.text,
      },
    })
    .returning(INBOUND_RECEIPT_COLUMNS);
  return row as IMessageRelayInboundReceipt;
}

export async function getLatestIMessageRelayInboundReceiptForMember(input: {
  workspaceId: string;
  memberId: string;
}): Promise<IMessageRelayInboundReceipt | undefined> {
  const [row] = await db
    .select(INBOUND_RECEIPT_COLUMNS)
    .from(imessageRelayInboundReceipts)
    .where(
      and(
        eq(imessageRelayInboundReceipts.workspaceId, input.workspaceId),
        eq(imessageRelayInboundReceipts.memberId, input.memberId),
      ),
    )
    .orderBy(desc(imessageRelayInboundReceipts.createdAt))
    .limit(1);
  return row as IMessageRelayInboundReceipt | undefined;
}

function rowToRelayJob(row: Record<string, unknown>): IMessageRelayJob {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    memberId: row.member_id ? String(row.member_id) : null,
    channelId: row.channel_id ? String(row.channel_id) : null,
    messageId: row.message_id ? String(row.message_id) : null,
    purpose: row.purpose as IMessageRelayJobPurpose,
    recipient: String(row.recipient),
    serviceName: row.service_name ? String(row.service_name) : null,
    body: String(row.body),
    receipt: row.receipt ? String(row.receipt) : null,
    status: row.status as IMessageRelayJobStatus,
    lockedBy: row.locked_by ? String(row.locked_by) : null,
    lockedUntil: row.locked_until instanceof Date ? row.locked_until : row.locked_until ? new Date(String(row.locked_until)) : null,
    sentAt: row.sent_at instanceof Date ? row.sent_at : row.sent_at ? new Date(String(row.sent_at)) : null,
    failedAt: row.failed_at instanceof Date ? row.failed_at : row.failed_at ? new Date(String(row.failed_at)) : null,
    error: row.error ? String(row.error) : null,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at)),
  };
}
