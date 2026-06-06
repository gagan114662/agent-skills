import type { FastifyInstance, FastifyReply } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import type { Identity } from "../auth/identity.js";
import {
  createChannel,
  getChannel,
  listChannels,
  archiveChannel,
  addChannelMember,
  removeChannelMember,
  isChannelMember,
  getOrCreateDm,
  type Channel,
} from "../db/repositories/channels.js";
import { postMessage, listChannelMessages } from "../db/repositories/messages.js";

/** Load a channel and assert the caller is a member of it (in their workspace). */
async function memberChannel(
  identity: Identity,
  channelId: string,
  reply: FastifyReply,
): Promise<Channel | undefined> {
  const ch = await getChannel(channelId);
  if (!ch || ch.workspaceId !== identity.workspaceId) {
    reply.code(404).send({ error: "channel not found" });
    return undefined;
  }
  if (!(await isChannelMember(channelId, identity.memberId))) {
    reply.code(403).send({ error: "not a channel member" });
    return undefined;
  }
  return ch;
}

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
    if (!(await memberChannel(id, cid, reply))) return;
    await archiveChannel(cid);
    return { ok: true };
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
    const ch = await memberChannel(id, cid, reply);
    if (!ch) return;
    if (ch.isArchived) return reply.code(409).send({ error: "channel is archived" });
    const b = req.body as { body?: string; parentMessageId?: string };
    if (!b.body) return reply.code(400).send({ error: "body required" });
    const message = await postMessage({
      workspaceId: id.workspaceId,
      channelId: cid,
      authorMemberId: id.memberId,
      body: b.body,
      parentMessageId: b.parentMessageId,
    });
    return reply.code(201).send(message);
  });

  // list messages (member-only)
  app.get("/channels/:cid/messages", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    if (!(await memberChannel(id, cid, reply))) return;
    return listChannelMessages(cid);
  });
}
