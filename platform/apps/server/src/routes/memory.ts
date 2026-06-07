import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import {
  upsertMemory,
  getMemory,
  listMemories,
  upsertEdge,
  getNeighbors,
} from "../db/repositories/memories.js";
import { dedupeKey } from "../memory/dedupe.js";
import { captureFromSource } from "../memory/capture.js";

/**
 * Typed context/memory graph endpoints (issue #15, ADR-0015). Thin: each authenticates (#3),
 * asserts the workspace boundary (`assertWorkspace`, the IDOR guard), validates the body, and
 * delegates to the repo / capture service. All typing, dedup, extraction, and traversal logic
 * lives in `memory/*` + the repo.
 */

/** Provenance kinds accepted by the schema CHECK (issue #15). */
const SOURCE_TYPES = ["message", "task", "file", "event", "manual"];

export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  // create a typed node (manual); dedup → 201 new / 200 merged-into-existing
  app.post("/workspaces/:wid/memories", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const b = req.body as {
      type?: string;
      text?: string;
      entity?: string;
      content?: Record<string, unknown>;
    };
    if (!b.type || !b.text) return reply.code(400).send({ error: "type and text required" });
    const entity = b.entity ?? null;
    const r = await upsertMemory({
      workspaceId: wid,
      type: b.type,
      content: { ...(b.content ?? {}), text: b.text },
      entity,
      dedupeKey: dedupeKey(b.type, b.text, entity),
      sourceType: "manual",
      createdByMemberId: id.memberId,
    });
    return reply.code(r.created ? 201 : 200).send(await getMemory(wid, r.id));
  });

  // query nodes by type and/or entity
  app.get("/workspaces/:wid/memories", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const q = req.query as { type?: string; entity?: string };
    return listMemories(wid, { type: q.type, entity: q.entity });
  });

  // auto-capture: extract typed nodes + edges from a piece of workspace activity
  app.post("/workspaces/:wid/memories/capture", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const b = req.body as { text?: string; sourceType?: string; sourceId?: string };
    if (!b.text) return reply.code(400).send({ error: "text required" });
    const sourceType = b.sourceType ?? "event";
    if (!SOURCE_TYPES.includes(sourceType)) {
      return reply.code(400).send({ error: `sourceType must be one of ${SOURCE_TYPES.join(", ")}` });
    }
    const result = await captureFromSource({
      workspaceId: wid,
      text: b.text,
      sourceType,
      sourceId: b.sourceId ?? null,
      createdByMemberId: id.memberId,
    });
    return reply.code(201).send(result);
  });

  // node + neighbors (1-hop graph traversal)
  app.get("/workspaces/:wid/memories/:id", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: memoryId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const node = await getMemory(wid, memoryId);
    if (!node) return reply.code(404).send({ error: "memory not found" });
    const neighbors = await getNeighbors(wid, memoryId);
    return { memory: node, ...neighbors };
  });

  // create a typed edge between two nodes; both endpoints must live in :wid (IDOR)
  app.post("/workspaces/:wid/memories/:id/edges", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: fromId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const b = req.body as { toMemoryId?: string; relation?: string };
    if (!b.toMemoryId || !b.relation) {
      return reply.code(400).send({ error: "toMemoryId and relation required" });
    }
    const [from, to] = await Promise.all([getMemory(wid, fromId), getMemory(wid, b.toMemoryId)]);
    if (!from || !to) {
      return reply.code(404).send({ error: "memory not found in this workspace" });
    }
    const r = await upsertEdge({
      workspaceId: wid,
      fromMemoryId: fromId,
      toMemoryId: b.toMemoryId,
      relation: b.relation,
      createdByMemberId: id.memberId,
    });
    return reply.code(r.created ? 201 : 200).send({
      id: r.id,
      fromMemoryId: fromId,
      toMemoryId: b.toMemoryId,
      relation: b.relation,
    });
  });
}
