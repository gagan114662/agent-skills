import { and, eq } from "drizzle-orm";
import { db } from "../index.js";
import { externalRoomMessageReceipts } from "../schema/index.js";

export type ExternalRoomMessageProvider = "telegram" | "whatsapp";

export interface ExternalRoomMessageReceipt {
  workspaceId: string;
  channelId: string;
  messageId: string;
  provider: ExternalRoomMessageProvider;
  providerConversationId: string;
  providerMessageId: string;
}

const receiptColumns = {
  workspaceId: externalRoomMessageReceipts.workspaceId,
  channelId: externalRoomMessageReceipts.channelId,
  messageId: externalRoomMessageReceipts.messageId,
  provider: externalRoomMessageReceipts.provider,
  providerConversationId: externalRoomMessageReceipts.providerConversationId,
  providerMessageId: externalRoomMessageReceipts.providerMessageId,
};

export async function recordExternalRoomMessageReceipt(input: ExternalRoomMessageReceipt): Promise<void> {
  await db
    .insert(externalRoomMessageReceipts)
    .values(input)
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
