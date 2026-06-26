import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { requireChannelCapability } from "../auth/access.js";
import { postMessage } from "../db/repositories/messages.js";
import { deliverPostedMessage } from "../messaging/delivery.js";
import { imessageRoomReceipt, type IMessageRelayService } from "../imessage/service.js";

export interface IMessageRoutesOptions {
  service: IMessageRelayService;
}

function statusCode(status: string): number {
  if (status === "disabled" || status === "not_configured") return 503;
  if (status === "too_long" || status === "failed") return 400;
  return 200;
}

export async function imessageRoutes(app: FastifyInstance, opts: IMessageRoutesOptions): Promise<void> {
  app.get("/me/imessage/status", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    return opts.service.status();
  });

  app.post("/me/imessage/test", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const body = (req.body ?? {}) as { text?: unknown };
    const text =
      typeof body.text === "string" && body.text.trim()
        ? body.text.trim()
        : "ipop test: your marketing team engine can reach iMessage.";
    const result = await opts.service.send({ text });
    return reply.code(statusCode(result.status)).send(result);
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
    const result = await opts.service.send({ text: relayText });
    return reply.code(statusCode(result.status)).send({
      ...result,
      receipt: "imessage:" + cid + ":" + message.id,
      message,
    });
  });
}
