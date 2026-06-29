import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { TELEGRAM_ROOM_CONNECTION_ID, WHATSAPP_ROOM_CONNECTION_ID } from "../connections/registry.js";
import {
  getServiceCredentialActor,
  getServiceStatus,
  resolveServiceSecrets,
} from "../db/repositories/external-credentials.js";
import { getLatestExternalRoomRoundTripProof } from "../db/repositories/external-room-message-receipts.js";
import {
  getIMessageRecipient,
  getLatestIMessageRelayHeartbeat,
  getLatestIMessageRelayInboundReceiptForMember,
  getLatestSentIMessageRelayJobForMember,
} from "../db/repositories/imessage.js";
import type { IMessageRelayService } from "../imessage/service.js";
import {
  buildExternalProviderReadiness,
  buildIMessageReadiness,
  buildMessagingReadinessReport,
  normalizeTelegramDestination,
  normalizeWhatsAppDestination,
} from "../messaging/readiness.js";
import type { TelegramRoomService } from "../telegram/service.js";
import type { WhatsAppRoomService } from "../whatsapp/service.js";

export interface MessagingReadinessRoutesOptions {
  telegram: TelegramRoomService;
  whatsapp: WhatsAppRoomService;
  imessage: IMessageRelayService;
}

const TELEGRAM_CHAT_ID_KEY = "TELEGRAM_CHAT_ID";
const WHATSAPP_RECIPIENT_KEY = "WHATSAPP_RECIPIENT";

export async function messagingReadinessRoutes(
  app: FastifyInstance,
  opts: MessagingReadinessRoutesOptions,
): Promise<void> {
  app.get("/me/messaging-readiness", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const nowMs = Date.now();

    const [
      telegramConnection,
      telegramActor,
      telegramSecrets,
      whatsappConnection,
      whatsappActor,
      whatsappSecrets,
      imessageRecipient,
      imessageHeartbeat,
      imessageOutbound,
      imessageInbound,
    ] = await Promise.all([
      getServiceStatus(identity.workspaceId, TELEGRAM_ROOM_CONNECTION_ID),
      getServiceCredentialActor(identity.workspaceId, TELEGRAM_ROOM_CONNECTION_ID),
      resolveServiceSecrets(identity.workspaceId, TELEGRAM_ROOM_CONNECTION_ID),
      getServiceStatus(identity.workspaceId, WHATSAPP_ROOM_CONNECTION_ID),
      getServiceCredentialActor(identity.workspaceId, WHATSAPP_ROOM_CONNECTION_ID),
      resolveServiceSecrets(identity.workspaceId, WHATSAPP_ROOM_CONNECTION_ID),
      getIMessageRecipient(identity.workspaceId, identity.memberId),
      getLatestIMessageRelayHeartbeat(),
      getLatestSentIMessageRelayJobForMember({ workspaceId: identity.workspaceId, memberId: identity.memberId }),
      getLatestIMessageRelayInboundReceiptForMember({ workspaceId: identity.workspaceId, memberId: identity.memberId }),
    ]);

    const telegramDestination = normalizeTelegramDestination(telegramSecrets[TELEGRAM_CHAT_ID_KEY]);
    const whatsappDestination = normalizeWhatsAppDestination(whatsappSecrets[WHATSAPP_RECIPIENT_KEY]);
    const [telegramProof, whatsappProof] = await Promise.all([
      telegramDestination
        ? getLatestExternalRoomRoundTripProof({
            workspaceId: identity.workspaceId,
            provider: "telegram",
            providerConversationId: telegramDestination,
          })
        : Promise.resolve({ outbound: undefined, inbound: undefined }),
      whatsappDestination
        ? getLatestExternalRoomRoundTripProof({
            workspaceId: identity.workspaceId,
            provider: "whatsapp",
            providerConversationId: whatsappDestination,
          })
        : Promise.resolve({ outbound: undefined, inbound: undefined }),
    ]);

    const imessageStatus = imessageRecipient
      ? opts.imessage.statusFor({
          recipient: imessageRecipient.recipient,
          source: imessageRecipient.verifiedAt ? "member_verified" : "member_pending",
          verified: Boolean(imessageRecipient.verifiedAt),
        })
      : opts.imessage.status();
    const telegramStatus = opts.telegram.status();
    const whatsappStatus = opts.whatsapp.status();

    return buildMessagingReadinessReport({
      nowMs,
      providers: [
        buildExternalProviderReadiness({
          provider: "telegram",
          label: "Telegram",
          configured: telegramStatus.configured,
          missingConfig: telegramStatus.missingEnv,
          connection: telegramConnection,
          connectedByMemberId: telegramActor?.connectedByMemberId ?? null,
          destination: telegramDestination,
          outboundProof: telegramProof.outbound,
          inboundProof: telegramProof.inbound,
          nowMs,
        }),
        buildExternalProviderReadiness({
          provider: "whatsapp",
          label: "WhatsApp",
          configured: whatsappStatus.configured,
          missingConfig: whatsappStatus.missingEnv,
          connection: whatsappConnection,
          connectedByMemberId: whatsappActor?.connectedByMemberId ?? null,
          destination: whatsappDestination,
          outboundProof: whatsappProof.outbound,
          inboundProof: whatsappProof.inbound,
          nowMs,
        }),
        buildIMessageReadiness({
          status: imessageStatus,
          recipient: imessageRecipient,
          latestSentJob: imessageOutbound,
          latestInboundReceipt: imessageInbound,
          relayHeartbeat: imessageHeartbeat,
          nowMs,
        }),
      ],
    });
  });
}
