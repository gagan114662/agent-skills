import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import {
  requireMemoryCapability,
  requireTaskInWorkspace,
  type Capability,
} from "../auth/access.js";
import {
  upsertMemory,
  getMemory,
  listMemories,
  upsertEdge,
  getNeighbors,
  supersedeMemory,
  linkMemoryFile,
  unlinkMemoryFile,
  listFilesForMemory,
  listMemoriesForFile,
  taskContextBuckets,
} from "../db/repositories/memories.js";
import { listTasksLinkingTo } from "../db/repositories/tasks.js";
import {
  grantCapability,
  revokeCapability,
  listResourceGrants,
} from "../db/repositories/permissions.js";
import { memberInWorkspace } from "../db/repositories/members.js";
import { dedupeKey } from "../memory/dedupe.js";
import { captureFromSource } from "../memory/capture.js";
import { rankRelevantContext } from "../memory/context.js";

/**
 * Shared, RBAC-guarded memory graph (issues #15 + #16, ADR-0016). Every route authenticates (#3),
 * then `requireMemoryCapability` enforces both the workspace boundary (the IDOR guard) and the #9
 * capability ladder on the `memory` resource (read to query/traverse, write to mutate, propagate
 * to administer grants). All typing/dedup/extraction/traversal/linking logic lives in `memory/*`
 * + the repo — routes stay thin.
 */

/** Provenance kinds accepted by the schema CHECK (issue #15). */
const SOURCE_TYPES = ["message", "task", "file", "event", "manual"];
/** RBAC levels grantable on the memory resource (issue #16). */
const CAPABILITIES: Capability[] = ["read", "write", "propagate"];

export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  // create a typed node (manual); dedup → 201 new / 200 merged-into-existing
  app.post("/workspaces/:wid/memories", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!(await requireMemoryCapability(id, wid, "write", reply))) return;
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

  // query nodes; ?type= ?entity= filter, ?file= resolves memories linked to a path (reverse),
  // ?includeStale=true surfaces superseded nodes (excluded by default).
  app.get("/workspaces/:wid/memories", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    const q = req.query as { type?: string; entity?: string; file?: string; includeStale?: string };
    if (q.file) return listMemoriesForFile(wid, q.file);
    return listMemories(wid, {
      type: q.type,
      entity: q.entity,
      includeStale: q.includeStale === "true",
    });
  });

  // auto-capture: extract typed nodes + edges from a piece of workspace activity
  app.post("/workspaces/:wid/memories/capture", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!(await requireMemoryCapability(id, wid, "write", reply))) return;
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
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
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
    if (!(await requireMemoryCapability(id, wid, "write", reply))) return;
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

  // supersede an existing node with a newer one: marks the old stale (kept), links new→supersedes→old
  app.post("/workspaces/:wid/memories/:id/supersede", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: oldId } = req.params as { wid: string; id: string };
    if (!(await requireMemoryCapability(id, wid, "write", reply))) return;
    const old = await getMemory(wid, oldId);
    if (!old) return reply.code(404).send({ error: "memory not found in this workspace" });
    const b = req.body as {
      type?: string;
      text?: string;
      entity?: string;
      content?: Record<string, unknown>;
    };
    if (!b.type || !b.text) return reply.code(400).send({ error: "type and text required" });
    const entity = b.entity ?? null;
    const r = await supersedeMemory({
      workspaceId: wid,
      oldId,
      type: b.type,
      content: { ...(b.content ?? {}), text: b.text },
      entity,
      dedupeKey: dedupeKey(b.type, b.text, entity),
      sourceType: "manual",
      createdByMemberId: id.memberId,
    });
    return reply.code(r.created ? 201 : 200).send({
      memory: await getMemory(wid, r.newId),
      supersededId: r.superseded ? oldId : null,
    });
  });

  // reverse resolve: tasks linking to this memory (the memory-side of #14 task_links)
  app.get("/workspaces/:wid/memories/:id/tasks", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: memoryId } = req.params as { wid: string; id: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    const node = await getMemory(wid, memoryId);
    if (!node) return reply.code(404).send({ error: "memory not found" });
    return listTasksLinkingTo(wid, "memory", memoryId);
  });

  // link a memory node to a file path (idempotent)
  app.post("/workspaces/:wid/memories/:id/files", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: memoryId } = req.params as { wid: string; id: string };
    if (!(await requireMemoryCapability(id, wid, "write", reply))) return;
    const node = await getMemory(wid, memoryId);
    if (!node) return reply.code(404).send({ error: "memory not found in this workspace" });
    const b = req.body as { path?: string };
    if (!b.path) return reply.code(400).send({ error: "path required" });
    const { created } = await linkMemoryFile({
      workspaceId: wid,
      memoryId,
      path: b.path,
      createdByMemberId: id.memberId,
    });
    return reply.code(created ? 201 : 200).send({ ok: true, created, path: b.path });
  });

  // unlink a file from a memory node
  app.delete("/workspaces/:wid/memories/:id/files", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: memoryId } = req.params as { wid: string; id: string };
    if (!(await requireMemoryCapability(id, wid, "write", reply))) return;
    const b = req.body as { path?: string };
    if (!b.path) return reply.code(400).send({ error: "path required" });
    const removed = await unlinkMemoryFile(wid, memoryId, b.path);
    if (!removed) return reply.code(404).send({ error: "file link not found" });
    return { ok: true };
  });

  // forward resolve: files linked to a memory node
  app.get("/workspaces/:wid/memories/:id/files", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: memoryId } = req.params as { wid: string; id: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    const node = await getMemory(wid, memoryId);
    if (!node) return reply.code(404).send({ error: "memory not found" });
    return listFilesForMemory(memoryId);
  });

  // relevant-context for a task: linked memories + their neighbors + label/entity matches (deduped,
  // ordered, stale dropped). The shared-memory payload an agent loads to work a task.
  app.get("/workspaces/:wid/tasks/:tid/context", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, tid } = req.params as { wid: string; tid: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    const task = await requireTaskInWorkspace(id, tid, reply);
    if (!task) return;
    const buckets = await taskContextBuckets(wid, tid, task.labels);
    const q = req.query as { includeStale?: string };
    return rankRelevantContext(buckets, { includeStale: q.includeStale === "true" });
  });

  // --- RBAC grants on the memory resource (#9 ladder, #16): propagate-only administration ---

  app.post("/workspaces/:wid/memory/grants", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!(await requireMemoryCapability(id, wid, "propagate", reply))) return;
    const b = req.body as { memberId?: string; capability?: string };
    if (!b.memberId) return reply.code(400).send({ error: "memberId required" });
    if (!b.capability || !CAPABILITIES.includes(b.capability as Capability)) {
      return reply.code(400).send({ error: "capability must be read | write | propagate" });
    }
    if (!(await memberInWorkspace(b.memberId, wid))) {
      return reply.code(404).send({ error: "member not found in this workspace" });
    }
    await grantCapability({
      workspaceId: wid,
      memberId: b.memberId,
      resourceType: "memory",
      resourceId: wid,
      capability: b.capability as Capability,
      grantedByMemberId: id.memberId,
    });
    return reply.code(201).send({ ok: true, memberId: b.memberId, capability: b.capability });
  });

  app.delete("/workspaces/:wid/memory/grants/:mid", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, mid } = req.params as { wid: string; mid: string };
    if (!(await requireMemoryCapability(id, wid, "propagate", reply))) return;
    await revokeCapability(wid, mid, "memory", wid);
    return { ok: true };
  });

  app.get("/workspaces/:wid/memory/grants", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!(await requireMemoryCapability(id, wid, "read", reply))) return;
    return listResourceGrants(wid, "memory", wid);
  });
}
