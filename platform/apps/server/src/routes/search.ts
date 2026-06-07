import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { parseSearchParams } from "./search-params.js";
import { searchMessages, searchChannels, searchMembers } from "../db/repositories/search.js";

/**
 * Search (#7): permission-scoped full-text search over messages, plus channel/member name
 * search. Routes stay thin — auth + workspace guard + param parsing here; the channel-level
 * access scoping lives in the repository as a SQL predicate (ADR-0007).
 */
export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:wid/search/messages", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const parsed = parseSearchParams(req.query as Record<string, unknown>);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const p = parsed.value;
    const results = await searchMessages({
      workspaceId: wid,
      callerMemberId: id.memberId,
      q: p.q,
      limit: p.limit,
      offset: p.offset,
      channelId: p.channelId,
      authorMemberId: p.authorMemberId,
      after: p.after,
      before: p.before,
      threadId: p.threadId,
    });
    return { query: p.q, limit: p.limit, offset: p.offset, results };
  });

  app.get("/workspaces/:wid/search/channels", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const parsed = parseSearchParams(req.query as Record<string, unknown>);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const p = parsed.value;
    const results = await searchChannels({
      workspaceId: wid,
      callerMemberId: id.memberId,
      q: p.q,
      limit: p.limit,
      offset: p.offset,
    });
    return { query: p.q, limit: p.limit, offset: p.offset, results };
  });

  app.get("/workspaces/:wid/search/members", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const parsed = parseSearchParams(req.query as Record<string, unknown>);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const p = parsed.value;
    const results = await searchMembers({
      workspaceId: wid,
      q: p.q,
      limit: p.limit,
      offset: p.offset,
    });
    return { query: p.q, limit: p.limit, offset: p.offset, results };
  });
}
