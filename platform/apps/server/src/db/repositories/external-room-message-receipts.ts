import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { externalRoomMessageReceipts, messages } from "../schema/index.js";

export type ExternalRoomMessageProvider = "telegram" | "whatsapp";
export type ExternalRoomMessageDirection = "outbound" | "inbound";

export interface ExternalRoomMessageReceipt {
  workspaceId: string;
  channelId: string;
  messageId: string;
  provider: ExternalRoomMessageProvider;
  providerConversationId: string;
  providerMessageId: string;
  direction?: ExternalRoomMessageDirection;
}

export interface ExternalRoomMessageProof {
  workspaceId: string;
  channelId: string;
  messageId: string;
  replyToMessageId?: string | null;
  provider: ExternalRoomMessageProvider;
  providerConversationId: string;
  providerMessageId: string;
  direction: ExternalRoomMessageDirection;
  createdAt: Date;
}

const receiptColumns = {
  workspaceId: externalRoomMessageReceipts.workspaceId,
  channelId: externalRoomMessageReceipts.channelId,
  messageId: externalRoomMessageReceipts.messageId,
  provider: externalRoomMessageReceipts.provider,
  providerConversationId: externalRoomMessageReceipts.providerConversationId,
  providerMessageId: externalRoomMessageReceipts.providerMessageId,
  direction: externalRoomMessageReceipts.direction,
  createdAt: externalRoomMessageReceipts.createdAt,
};

const threadedReceiptColumns = {
  ...receiptColumns,
  replyToMessageId: messages.parentMessageId,
};

async function getLatestInboundExternalRoomMessageProof(input: {
  workspaceId: string;
  provider: ExternalRoomMessageProvider;
  providerConversationId?: string;
  channelId?: string;
  replyToMessageId?: string;
}): Promise<ExternalRoomMessageProof | undefined> {
  const predicates = [
    eq(externalRoomMessageReceipts.workspaceId, input.workspaceId),
    eq(externalRoomMessageReceipts.provider, input.provider),
    eq(externalRoomMessageReceipts.direction, "inbound"),
  ];
  if (input.providerConversationId) {
    predicates.push(eq(externalRoomMessageReceipts.providerConversationId, input.providerConversationId));
  }
  if (input.channelId) {
    predicates.push(eq(externalRoomMessageReceipts.channelId, input.channelId));
  }
  if (input.replyToMessageId) {
    predicates.push(eq(messages.parentMessageId, input.replyToMessageId));
  }

  const [row] = await db
    .select(threadedReceiptColumns)
    .from(externalRoomMessageReceipts)
    .innerJoin(messages, eq(externalRoomMessageReceipts.messageId, messages.id))
    .where(and(...predicates))
    .orderBy(desc(externalRoomMessageReceipts.createdAt))
    .limit(1);
  return row as ExternalRoomMessageProof | undefined;
}

export async function recordExternalRoomMessageReceipt(input: ExternalRoomMessageReceipt): Promise<void> {
  await db
    .insert(externalRoomMessageReceipts)
    .values({ ...input, direction: input.direction ?? "outbound" })
    .onConflictDoUpdate({
      target: [
        externalRoomMessageReceipts.provider,
        externalRoomMessageReceipts.providerConversationId,
        externalRoomMessageReceipts.providerMessageId,
      ],
      set: {
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        messageId: input.messageId,
        direction: input.direction ?? "outbound",
      },
    });
}

export async function getExternalRoomMessageReceipt(input: {
  provider: ExternalRoomMessageProvider;
  providerConversationId: string;
  providerMessageId: string;
}): Promise<ExternalRoomMessageReceipt | undefined> {
  const [row] = await db
    .select(receiptColumns)
    .from(externalRoomMessageReceipts)
    .where(
      and(
        eq(externalRoomMessageReceipts.provider, input.provider),
        eq(externalRoomMessageReceipts.providerConversationId, input.providerConversationId),
        eq(externalRoomMessageReceipts.providerMessageId, input.providerMessageId),
      ),
    )
    .limit(1);
  return row as ExternalRoomMessageReceipt | undefined;
}

export async function getExternalRoomMessageReceiptForMessage(input: {
  provider: ExternalRoomMessageProvider;
  providerConversationId: string;
  messageId: string;
}): Promise<ExternalRoomMessageReceipt | undefined> {
  const [row] = await db
    .select(receiptColumns)
    .from(externalRoomMessageReceipts)
    .where(
      and(
        eq(externalRoomMessageReceipts.provider, input.provider),
        eq(externalRoomMessageReceipts.providerConversationId, input.providerConversationId),
        eq(externalRoomMessageReceipts.messageId, input.messageId),
      ),
    )
    .limit(1);
  return row as ExternalRoomMessageReceipt | undefined;
}

export async function getLatestExternalRoomMessageProof(input: {
  workspaceId: string;
  provider: ExternalRoomMessageProvider;
  direction: ExternalRoomMessageDirection;
  providerConversationId?: string;
}): Promise<ExternalRoomMessageProof | undefined> {
  const predicates = [
    eq(externalRoomMessageReceipts.workspaceId, input.workspaceId),
    eq(externalRoomMessageReceipts.provider, input.provider),
    eq(externalRoomMessageReceipts.direction, input.direction),
  ];
  if (input.providerConversationId) {
    predicates.push(eq(externalRoomMessageReceipts.providerConversationId, input.providerConversationId));
  }

  const [row] = await db
    .select(receiptColumns)
    .from(externalRoomMessageReceipts)
    .where(and(...predicates))
    .orderBy(desc(externalRoomMessageReceipts.createdAt))
    .limit(1);
  return row as ExternalRoomMessageProof | undefined;
}

export async function getLatestExternalRoomRoundTripProof(input: {
  workspaceId: string;
  provider: ExternalRoomMessageProvider;
  providerConversationId?: string;
}): Promise<{ outbound?: ExternalRoomMessageProof; inbound?: ExternalRoomMessageProof }> {
  const latestInbound = await getLatestInboundExternalRoomMessageProof(input);
  const outbound = await getLatestExternalRoomMessageProof({
    workspaceId: input.workspaceId,
    provider: input.provider,
    direction: "outbound",
    providerConversationId: input.providerConversationId,
  });
  if (!outbound) return { inbound: latestInbound };

  const threadedInbound = await getLatestInboundExternalRoomMessageProof({
    ...input,
    channelId: outbound.channelId,
    replyToMessageId: outbound.messageId,
  });

  return { outbound, inbound: threadedInbound ?? latestInbound };
}
