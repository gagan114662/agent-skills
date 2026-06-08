import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { requireChannelCapability } from "../auth/access.js";
import {
  createChannel,
  getChannel,
  listChannels,
  archiveChannel,
  addChannelMember,
  removeChannelMember,
  isChannelMember,
  getOrCreateDm,
} from "../db/repositories/channels.js";
import {
  grantCapability,
  revokeCapability,
  listResourceGrants,
  type Capability,
} from "../db/repositories/permissions.js";
import { memberInWorkspace } from "../db/repositories/members.js";
import {
  postMessage,
  listChannelMessages,
  listThreadReplies,
  countReplies,
} from "../db/repositories/messages.js";
import { resolveThreadRoot } from "../messaging/threads.js";
import { deliverPostedMessage, deliverThreadReply } from "../messaging/delivery.js";

const CAPABILITIES: Capability[] = ["read", "write", "propagate"];

export async function channelRoutes(app: FastifyInstance): Promise<void> {
  // create a public channel (creator auto-joins)
  app.post("/workspaces/:wid/channels", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const b = req.body as { name?: string };
    if (!b.name) return reply.code(400).send({ error: "name required" });
    const channel = await createChannel({ workspaceId: wid, kind: "public", name: b.name });
    await addChannelMember(channel.id, id.memberId);
    // The creator is the channel's first administrator (#9): an explicit propagate grant.
    await grantCapability({
      workspaceId: wid,
      memberId: id.memberId,
      resourceType: "channel",
      resourceId: channel.id,
      capability: "propagate",
      grantedByMemberId: id.memberId,
    });
    return reply.code(201).send(channel);
  });

  // list non-archived channels in the workspace
  app.get("/workspaces/:wid/channels", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return listChannels(wid);
  });

  // get-or-create a DM for a member set (caller is always included)
  app.post("/workspaces/:wid/dms", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const b = req.body as { memberIds?: string[] };
    const members = [...new Set([id.memberId, ...(b.memberIds ?? [])])];
    if (members.length < 2) return reply.code(400).send({ error: "a DM needs at least 2 members" });
    return getOrCreateDm(wid, members);
  });

  app.post("/channels/:cid/archive", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    // archiving is a write to the channel — a read-only role can't do it
    if (!(await requireChannelCapability(id, cid, "write", reply))) return;
    await archiveChannel(cid);
    return { ok: true };
  });

  // --- RBAC grants (#9): propagate-only administration of channel roles ---

  // grant/upsert a role to a member (auto-adds them to the channel)
  app.post("/channels/:cid/grants", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    if (!(await requireChannelCapability(id, cid, "propagate", reply))) return;
    const b = req.body as { memberId?: string; capability?: string };
    if (!b.memberId) return reply.code(400).send({ error: "memberId required" });
    if (!b.capability || !CAPABILITIES.includes(b.capability as Capability)) {
      return reply.code(400).send({ error: "capability must be read | write | propagate" });
    }
    // cross-workspace guard: never grant a role to a member from another workspace (IDOR)
    if (!(await memberInWorkspace(b.memberId, id.workspaceId))) {
      return reply.code(404).send({ error: "member not found in this workspace" });
    }
    await addChannelMember(cid, b.memberId); // granting access implies presence
    await grantCapability({
      workspaceId: id.workspaceId,
      memberId: b.memberId,
      resourceType: "channel",
      resourceId: cid,
      capability: b.capability as Capability,
      grantedByMemberId: id.memberId,
    });
    return reply.code(201).send({ ok: true, memberId: b.memberId, capability: b.capability });
  });

  // revoke a member's explicit role (immediate effect)
  app.delete("/channels/:cid/grants/:mid", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, mid } = req.params as { cid: string; mid: string };
    if (!(await requireChannelCapability(id, cid, "propagate", reply))) return;
    await revokeCapability(id.workspaceId, mid, "channel", cid);
    return { ok: true };
  });

  // list the channel's explicit role grants (read access)
  app.get("/channels/:cid/grants", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    if (!(await requireChannelCapability(id, cid, "read", reply))) return;
    return listResourceGrants(id.workspaceId, "channel", cid);
  });

  // join (self) or add a member to a public channel
  app.post("/channels/:cid/members", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    const ch = await getChannel(cid);
    if (!ch || ch.workspaceId !== id.workspaceId) {
      return reply.code(404).send({ error: "channel not found" });
    }
    const b = req.body as { memberId?: string };
    const target = b.memberId ?? id.memberId;
    // self-join is open for public channels; adding *others* requires being a member already
    if (target !== id.memberId && !(await isChannelMember(cid, id.memberId))) {
      return reply.code(403).send({ error: "not a channel member" });
    }
    if (ch.kind !== "public" && target !== id.memberId) {
      return reply.code(403).send({ error: "cannot add members to a DM" });
    }
    await addChannelMember(cid, target);
    return reply.code(201).send({ ok: true });
  });

  app.delete("/channels/:cid/members/:mid", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, mid } = req.params as { cid: string; mid: string };
    const ch = await getChannel(cid);
    if (!ch || ch.workspaceId !== id.workspaceId) {
      return reply.code(404).send({ error: "channel not found" });
    }
    // members can remove themselves; removing others requires membership too
    if (mid !== id.memberId && !(await isChannelMember(cid, id.memberId))) {
      return reply.code(403).send({ error: "not a channel member" });
    }
    await removeChannelMember(cid, mid);
    return { ok: true };
  });

  // post a message (member-only, not archived)
  app.post("/channels/:cid/messages", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    const ch = await requireChannelCapability(id, cid, "write", reply);
    if (!ch) return;
    if (ch.isArchived) return reply.code(409).send({ error: "channel is archived" });
    const b = req.body as { body?: string; parentMessageId?: string };
    if (!b.body) return reply.code(400).send({ error: "body required" });
    // If this is a reply, validate the parent and flatten nesting to the thread root (#6).
    let parentMessageId: string | undefined;
    if (b.parentMessageId) {
      const root = await resolveThreadRoot(b.parentMessageId, cid);
      if (!root) return reply.code(404).send({ error: "parent message not found in this channel" });
      parentMessageId = root.id;
    }
    const message = await postMessage({
      workspaceId: id.workspaceId,
      channelId: cid,
      authorMemberId: id.memberId,
      body: b.body,
      parentMessageId,
    });
    // Realtime broadcast (#5) + mention (#6/#8) + DM (#8) fan-out, shared with the MCP
    // `post_message` tool (#10). Best-effort on top of the REST source of truth.
    await deliverPostedMessage(req.log, id, ch, message);
    return reply.code(201).send(message);
  });

  // post a threaded reply to a message (write capability, channel not archived)
  app.post("/channels/:cid/messages/:mid/replies", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, mid } = req.params as { cid: string; mid: string };
    const ch = await requireChannelCapability(id, cid, "write", reply);
    if (!ch) return;
    if (ch.isArchived) return reply.code(409).send({ error: "channel is archived" });
    const b = req.body as { body?: string; alsoSendToChannel?: boolean };
    if (!b.body) return reply.code(400).send({ error: "body required" });
    // Flatten nesting: a reply always attaches to the thread root (Slack semantics, #6).
    const root = await resolveThreadRoot(mid, cid);
    if (!root) return reply.code(404).send({ error: "parent message not found in this channel" });
    const message = await postMessage({
      workspaceId: id.workspaceId,
      channelId: cid,
      authorMemberId: id.memberId,
      body: b.body,
      parentMessageId: root.id,
      alsoSentToChannel: b.alsoSendToChannel ?? false,
    });
    // Realtime broadcast (#5) + mention (#6/#8) fan-out + a `reply` notification to the thread
    // root's author (#8), shared with the MCP `reply_thread` tool (#10).
    await deliverThreadReply(req.log, id, ch, message, root.authorMemberId);
    return reply.code(201).send(message);
  });

  // view a thread: the root message + its replies in order, with a reply count (read capability)
  app.get("/channels/:cid/messages/:mid/thread", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, mid } = req.params as { cid: string; mid: string };
    if (!(await requireChannelCapability(id, cid, "read", reply))) return;
    const root = await resolveThreadRoot(mid, cid);
    if (!root) return reply.code(404).send({ error: "message not found in this channel" });
    const [replies, replyCount] = await Promise.all([
      listThreadReplies(root.id),
      countReplies(root.id),
    ]);
    return { root, replies, replyCount };
  });

  // list messages (read capability)
  app.get("/channels/:cid/messages", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    if (!(await requireChannelCapability(id, cid, "read", reply))) return;
    return listChannelMessages(cid);
  });
}
