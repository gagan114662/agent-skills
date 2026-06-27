import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { requireChannelCapability } from "../auth/access.js";
import { postMessage } from "../db/repositories/messages.js";
import {
  deleteIMessageRecipient,
  getIMessageRecipient,
  markIMessageRecipientVerified,
  upsertIMessageRecipient,
  type IMessageRecipient,
} from "../db/repositories/imessage.js";
import { deliverPostedMessage } from "../messaging/delivery.js";
import {
  imessageRoomPreflight,
  imessageRoomReceipt,
  type IMessageRelayService,
} from "../imessage/service.js";

export interface IMessageRoutesOptions {
  service: IMessageRelayService;
}

function statusCode(status: string): number {
  if (status === "disabled" || status === "not_configured") return 503;
  if (status === "too_long" || status === "failed") return 400;
  return 200;
}

function normalizeRecipient(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const recipient = raw.trim();
  if (recipient.length < 3 || recipient.length > 180) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return recipient.toLowerCase();
  if (/^\+?[0-9][0-9 .()-]{6,24}$/.test(recipient)) return recipient.replace(/[ .()-]/g, "");
  return null;
}

function normalizeServiceName(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return null;
  const serviceName = raw.trim();
  if (serviceName.length === 0) return null;
  if (serviceName.length > 120) return null;
  return serviceName;
}

function recipientPayload(row: IMessageRecipient | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    recipient: row.recipient,
    serviceName: row.serviceName,
    verified: Boolean(row.verifiedAt),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
  };
}

async function memberStatus(service: IMessageRelayService, workspaceId: string, memberId: string) {
  const row = await getIMessageRecipient(workspaceId, memberId);
  if (!row) return { status: service.status(), row };
  const verified = Boolean(row.verifiedAt);
  return {
    row,
    status: service.statusFor({
      recipient: row.recipient,
      source: verified ? "member_verified" : "member_pending",
      verified,
    }),
  };
}

export async function imessageRoutes(app: FastifyInstance, opts: IMessageRoutesOptions): Promise<void> {
  app.get("/me/imessage/status", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { status, row } = await memberStatus(opts.service, identity.workspaceId, identity.memberId);
    return { ...status, memberRecipient: recipientPayload(row) };
  });

  app.put("/me/imessage/recipient", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    if (identity.kind !== "human") return reply.code(403).send({ error: "only a human member can connect iMessage" });
    const body = (req.body ?? {}) as { recipient?: unknown; serviceName?: unknown };
    const recipient = normalizeRecipient(body.recipient);
    if (!recipient) {
      return reply.code(400).send({
        error: "recipient must be an iMessage email address or phone number",
      });
    }
    const serviceName = normalizeServiceName(body.serviceName);
    const row = await upsertIMessageRecipient({
      workspaceId: identity.workspaceId,
      memberId: identity.memberId,
      recipient,
      serviceName,
    });
    return reply.code(202).send({
      status: "pending_verification",
      recipient: row.recipient,
      serviceName: row.serviceName,
      verified: false,
      message: "Send a test message before using this iMessage destination for the agent room.",
    });
  });

  app.delete("/me/imessage/recipient", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    await deleteIMessageRecipient(identity.workspaceId, identity.memberId);
    return reply.code(204).send();
  });

  app.post("/me/imessage/test", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const body = (req.body ?? {}) as { text?: unknown };
    const text =
      typeof body.text === "string" && body.text.trim()
        ? body.text.trim()
        : "ipop test: your marketing team engine can reach iMessage.";
    const row = await getIMessageRecipient(identity.workspaceId, identity.memberId);
    const result = await opts.service.send({ text, recipient: row?.recipient, serviceName: row?.serviceName ?? undefined });
    if (row && result.status === "sent") {
      const verified = await markIMessageRecipientVerified({
        workspaceId: identity.workspaceId,
        memberId: identity.memberId,
        recipient: row.recipient,
      });
      return reply.code(200).send({ ...result, memberRecipient: recipientPayload(verified) });
    }
    return reply.code(statusCode(result.status)).send({ ...result, memberRecipient: recipientPayload(row) });
  });

  app.post("/channels/:cid/imessage/room", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { cid } = req.params as { cid: string };
    const channel = await requireChannelCapability(identity, cid, "write", reply);
    if (!channel) return;
    if (channel.isArchived) return reply.code(409).send({ error: "channel is archived" });

    const body = (req.body ?? {}) as { text?: unknown };
    const text =
      typeof body.text === "string" && body.text.trim()
        ? body.text.trim()
        : "start the iMessage room and show me what the team is doing.";
    const { status } = await memberStatus(opts.service, identity.workspaceId, identity.memberId);
    const preflight = imessageRoomPreflight(status);
    if (preflight) return reply.code(statusCode(preflight.status)).send(preflight);

    const message = await postMessage({
      workspaceId: identity.workspaceId,
      channelId: cid,
      authorMemberId: identity.memberId,
      body: text,
    });
    await deliverPostedMessage(req.log, identity, channel, message);

    const relayText = imessageRoomReceipt({
      workspaceId: identity.workspaceId,
      channelId: cid,
      messageId: message.id,
      author: identity.displayName,
      text,
    });
    const row = await getIMessageRecipient(identity.workspaceId, identity.memberId);
    const result = await opts.service.send({
      text: relayText,
      recipient: status.recipient,
      serviceName: row?.verifiedAt ? row.serviceName ?? undefined : undefined,
    });
    return reply.code(statusCode(result.status)).send({
      ...result,
      receipt: "imessage:" + cid + ":" + message.id,
      message,
    });
  });
}
