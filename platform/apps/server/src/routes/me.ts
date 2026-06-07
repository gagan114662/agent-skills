import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import {
  listMentionsForMember,
  countMentionsForMember,
} from "../db/repositories/mentions.js";

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    return identity;
  });

  // The caller's @mentions in their workspace, newest first (#6).
  app.get("/me/mentions", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    return listMentionsForMember(identity.workspaceId, identity.memberId);
  });

  // How many times the caller has been mentioned in their workspace (#6).
  app.get("/me/mentions/count", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    return { count: await countMentionsForMember(identity.workspaceId, identity.memberId) };
  });
}
