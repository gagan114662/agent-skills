import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { requireChannelCapability } from "../auth/access.js";
import { postMessage } from "../db/repositories/messages.js";
import {
  deleteIMessageRecipient,
  claimIMessageRelayJobs,
  completeIMessageRelayJob,
  enqueueIMessageRelayJob,
  findVerifiedIMessageRecipientByRecipient,
  getIMessageRecipient,
  markIMessageRecipientVerified,
  upsertIMessageRecipient,
  type IMessageRelayJob,
  type IMessageRecipient,
} from "../db/repositories/imessage.js";
import { getChannel } from "../db/repositories/channels.js";
import { getMessage } from "../db/repositories/messages.js";
import { deliverPostedMessage, deliverThreadReply } from "../messaging/delivery.js";
import { parseVisibilityChannelCommand } from "../messaging/visibility-commands.js";
import {
  imessageRoomPreflight,
  imessageRoomReceipt,
  parseIMessageRoomReceipt,
  type IMessageRelayService,
} from "../imessage/service.js";

export interface IMessageRoutesOptions {
  service: IMessageRelayService;
  webhookSecret?: string;
}

function statusCode(status: string): number {
  if (status === "disabled" || status === "not_configured") return 503;
  if (status === "too_long" || status === "failed") return 400;
  if (status === "queued") return 202;
  return 200;
}

function requireRelaySecret(req: FastifyRequest, reply: FastifyReply, secret?: string): boolean {
  if (!secret) {
    reply.code(503).send({ error: "iMessage relay is not configured" });
    return false;
  }
  const header = req.headers["x-ipop-imessage-relay-secret"];
  const presented = Array.isArray(header) ? header[0] : header;
  if (presented !== secret) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  return true;
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

function relayJobPayload(job: IMessageRelayJob): Record<string, unknown> {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    memberId: job.memberId,
    channelId: job.channelId,
    messageId: job.messageId,
    purpose: job.purpose,
    recipient: job.recipient,
    serviceName: job.serviceName,
    text: job.body,
    receipt: job.receipt,
    status: job.status,
    lockedBy: job.lockedBy,
    lockedUntil: job.lockedUntil?.toISOString() ?? null,
    sentAt: job.sentAt?.toISOString() ?? null,
    failedAt: job.failedAt?.toISOString() ?? null,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

async function enqueueRelaySend(input: {
  workspaceId: string;
  memberId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  purpose: "verification" | "room" | "notification";
  recipient: string;
  serviceName?: string | null;
  text: string;
  receipt?: string | null;
}): Promise<{ status: "queued"; dryRun: false; recipient: string; jobId: string; receipt?: string | null }> {
  const job = await enqueueIMessageRelayJob({
    workspaceId: input.workspaceId,
    memberId: input.memberId ?? null,
    channelId: input.channelId ?? null,
    messageId: input.messageId ?? null,
    purpose: input.purpose,
    recipient: input.recipient,
    serviceName: input.serviceName ?? null,
    body: input.text,
    receipt: input.receipt ?? null,
  });
  return { status: "queued", dryRun: false, recipient: input.recipient, jobId: job.id, receipt: input.receipt ?? null };
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
    const rowStatus = row
      ? opts.service.statusFor({ recipient: row.recipient, source: "member_pending", verified: false })
      : null;
    if (row && rowStatus && opts.webhookSecret && !rowStatus.enabled && !rowStatus.dryRun) {
      if (text.length > rowStatus.maxChars) {
        return reply.code(400).send({ status: "too_long", dryRun: false, recipient: row.recipient, error: "message too long" });
      }
      const queued = await enqueueRelaySend({
        workspaceId: identity.workspaceId,
        memberId: identity.memberId,
        purpose: "verification",
        recipient: row.recipient,
        serviceName: row.serviceName,
        text,
      });
      return reply.code(202).send({ ...queued, memberRecipient: recipientPayload(row) });
    }
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
    const canQueue = Boolean(preflight?.status === "disabled" && opts.webhookSecret && status.recipient && status.configured && !status.dryRun);
    if (preflight && !canQueue) return reply.code(statusCode(preflight.status)).send(preflight);

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
    const receipt = "imessage:" + cid + ":" + message.id;
    const result = canQueue
      ? await enqueueRelaySend({
          workspaceId: identity.workspaceId,
          memberId: identity.memberId,
          channelId: cid,
          messageId: message.id,
          purpose: "room",
          recipient: status.recipient!,
          serviceName: row?.verifiedAt ? row.serviceName ?? undefined : undefined,
          text: relayText,
          receipt,
        })
      : await opts.service.send({
          text: relayText,
          recipient: status.recipient,
          serviceName: row?.verifiedAt ? row.serviceName ?? undefined : undefined,
        });
    return reply.code(statusCode(result.status)).send({
      ...result,
      receipt,
      message,
    });
  });

  app.post("/imessage/relay/outbound/claim", async (req, reply) => {
    if (!requireRelaySecret(req, reply, opts.webhookSecret)) return;
    const body = (req.body ?? {}) as { relayId?: unknown; limit?: unknown; leaseMs?: unknown };
    const relayId = typeof body.relayId === "string" && body.relayId.trim() ? body.relayId.trim().slice(0, 120) : "mac-relay";
    const limit = typeof body.limit === "number" ? body.limit : 5;
    const leaseMs = typeof body.leaseMs === "number" ? body.leaseMs : 120_000;
    const jobs = await claimIMessageRelayJobs({ relayId, limit, leaseMs });
    return { jobs: jobs.map(relayJobPayload) };
  });

  app.post("/imessage/relay/outbound/:id/complete", async (req, reply) => {
    if (!requireRelaySecret(req, reply, opts.webhookSecret)) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { relayId?: unknown; status?: unknown; error?: unknown };
    const relayId = typeof body.relayId === "string" && body.relayId.trim() ? body.relayId.trim().slice(0, 120) : "mac-relay";
    const status = body.status === "sent" ? "sent" : body.status === "failed" ? "failed" : null;
    if (!status) return reply.code(400).send({ error: "status must be sent or failed" });
    const error = typeof body.error === "string" ? body.error.slice(0, 500) : null;
    const job = await completeIMessageRelayJob({ id, relayId, status, error });
    if (!job) return reply.code(409).send({ error: "iMessage relay job is not claimed by this relay" });
    let memberRecipient: Record<string, unknown> | null = null;
    if (job.purpose === "verification" && job.memberId && status === "sent") {
      const verified = await markIMessageRecipientVerified({
        workspaceId: job.workspaceId,
        memberId: job.memberId,
        recipient: job.recipient,
      });
      memberRecipient = recipientPayload(verified);
    }
    return { job: relayJobPayload(job), memberRecipient };
  });

  app.post("/imessage/relay/inbound", async (req, reply) => {
    if (!requireRelaySecret(req, reply, opts.webhookSecret)) return;

    const body = (req.body ?? {}) as {
      workspaceId?: unknown;
      receipt?: unknown;
      sender?: unknown;
      text?: unknown;
    };
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    const receipt = parseIMessageRoomReceipt(body.receipt);
    const sender = normalizeRecipient(body.sender);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!workspaceId || !receipt || !sender || !text) {
      return reply.code(400).send({ error: "workspaceId, receipt, sender, and text are required" });
    }

    const original = await getMessage(receipt.messageId);
    if (!original || original.channelId !== receipt.channelId) {
      return reply.code(404).send({ error: "iMessage room receipt not found" });
    }
    const channel = await getChannel(receipt.channelId);
    if (!channel || channel.workspaceId !== workspaceId || channel.isArchived) {
      return reply.code(404).send({ error: "iMessage room channel not found" });
    }
    const recipient = await findVerifiedIMessageRecipientByRecipient({ workspaceId, recipient: sender });
    if (!recipient) return reply.code(403).send({ error: "sender is not a verified iMessage recipient" });

    const message = await postMessage({
      workspaceId,
      channelId: receipt.channelId,
      authorMemberId: recipient.memberId,
      parentMessageId: receipt.messageId,
      alsoSentToChannel: true,
      body: text,
    });
    await deliverThreadReply(
      req.log,
      { workspaceId, memberId: recipient.memberId, kind: "human", displayName: "iMessage" },
      channel,
      message,
      original.authorMemberId,
    );
    const command = parseVisibilityChannelCommand(text);
    return reply.code(201).send({
      status: "ingested",
      receipt: body.receipt,
      message,
      command,
    });
  });
}
