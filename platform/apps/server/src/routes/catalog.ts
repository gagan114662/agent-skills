import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { loadConfig } from "../config/loader.js";
import { resolveCatalogCaps } from "../catalog/caps.js";
import {
  isCatalogKind,
  isCatalogProvenance,
  isCatalogStatus,
  type CatalogEntryInput,
} from "../catalog/types.js";
import {
  createCatalogEntry,
  countCatalogEntries,
  deleteCatalogEntry,
  getCatalogEntry,
  listCatalogEntries,
  updateCatalogEntry,
} from "../db/repositories/catalog.js";
import type { WorkflowEngine } from "../workflows/engine.js";

/**
 * Workspace catalog routes (#152, ADR-0152) under `/workspaces/:wid/catalog`. Thin adapters over the
 * catalog repo, tenant-scoped via the #19 `assertWorkspace` boundary. **Default-OFF**: every route 403s
 * unless the per-tenant `catalog` config is enabled, so the feature is dark until an owner opts in.
 * Agents read the catalog for context through the SAME `GET` route (they already carry an identity).
 *
 * A create/update/delete best-effort fires `catalog_change` workflows (#152 part 2) — never awaited, so
 * a slow agent launch never blocks the catalog write.
 */
export interface CatalogRoutesOptions {
  /** The workflow engine — a catalog mutation fires its `catalog_change` triggers (best-effort). */
  workflowEngine?: WorkflowEngine;
}

function readMetadata(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

export async function catalogRoutes(app: FastifyInstance, opts: CatalogRoutesOptions = {}): Promise<void> {
  /** Gate every catalog route on the per-tenant flag (default OFF). Returns the caps, or null on 403. */
  async function gateEnabled(wid: string, reply: import("fastify").FastifyReply): Promise<ReturnType<typeof resolveCatalogCaps> | null> {
    const caps = resolveCatalogCaps(loadConfig(wid).catalog);
    if (!caps.enabled) {
      void reply.code(403).send({ error: "catalog is not enabled for this workspace" });
      return null;
    }
    return caps;
  }

  /** Fire catalog_change workflows for a mutation — best-effort, never awaited on the request path. */
  function fireChange(wid: string, kind: string): void {
    if (!opts.workflowEngine) return;
    void opts.workflowEngine.fireEvent(wid, "catalog_change", { catalogKind: kind }).catch(() => {});
  }

  /** List the workspace catalog (optionally filtered by `?kind=`). The agent-readable context surface. */
  app.get("/workspaces/:wid/catalog", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!(await gateEnabled(wid, reply))) return;
    const { kind } = req.query as { kind?: string };
    const filter = kind && isCatalogKind(kind) ? kind : undefined;
    return listCatalogEntries(wid, filter);
  });

  /** Register a new catalog entry. */
  app.post("/workspaces/:wid/catalog", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const caps = await gateEnabled(wid, reply);
    if (!caps) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isCatalogKind(body.kind)) {
      return reply.code(400).send({ error: "kind must be a known catalog kind" });
    }
    if (typeof body.name !== "string" || !body.name.trim()) {
      return reply.code(400).send({ error: "name is required" });
    }
    if (body.status !== undefined && !isCatalogStatus(body.status)) {
      return reply.code(400).send({ error: "status must be active/inactive/pending/archived" });
    }
    if (body.provenance !== undefined && !isCatalogProvenance(body.provenance)) {
      return reply.code(400).send({ error: "provenance must be manual/synced/agent" });
    }
    if ((await countCatalogEntries(wid)) >= caps.maxEntries) {
      return reply.code(429).send({ error: "catalog entry limit reached" });
    }

    const input: CatalogEntryInput = {
      kind: body.kind,
      name: body.name.trim(),
      identifier: typeof body.identifier === "string" ? body.identifier : undefined,
      status: isCatalogStatus(body.status) ? body.status : undefined,
      provenance: isCatalogProvenance(body.provenance) ? body.provenance : undefined,
      ownerMemberId: typeof body.ownerMemberId === "string" ? body.ownerMemberId : undefined,
      metadata: readMetadata(body.metadata),
    };
    const entry = await createCatalogEntry(wid, id.memberId, input);
    fireChange(wid, entry.kind);
    return reply.code(201).send(entry);
  });

  /** Patch a catalog entry (partial). */
  app.patch("/workspaces/:wid/catalog/:id", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: entryId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!(await gateEnabled(wid, reply))) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<CatalogEntryInput> = {};
    if (body.kind !== undefined) {
      if (!isCatalogKind(body.kind)) return reply.code(400).send({ error: "kind must be a known catalog kind" });
      patch.kind = body.kind;
    }
    if (typeof body.name === "string") patch.name = body.name.trim();
    if (typeof body.identifier === "string") patch.identifier = body.identifier;
    if (body.status !== undefined) {
      if (!isCatalogStatus(body.status)) return reply.code(400).send({ error: "invalid status" });
      patch.status = body.status;
    }
    if (body.provenance !== undefined) {
      if (!isCatalogProvenance(body.provenance)) return reply.code(400).send({ error: "invalid provenance" });
      patch.provenance = body.provenance;
    }
    if (body.ownerMemberId !== undefined) {
      patch.ownerMemberId = typeof body.ownerMemberId === "string" ? body.ownerMemberId : null;
    }
    if (body.metadata !== undefined) patch.metadata = readMetadata(body.metadata);

    const updated = await updateCatalogEntry(wid, entryId, patch);
    if (!updated) return reply.code(404).send({ error: "catalog entry not found" });
    fireChange(wid, updated.kind);
    return updated;
  });

  /** Delete a catalog entry. */
  app.delete("/workspaces/:wid/catalog/:id", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: entryId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!(await gateEnabled(wid, reply))) return;
    const existing = await getCatalogEntry(wid, entryId);
    const ok = await deleteCatalogEntry(wid, entryId);
    if (!ok) return reply.code(404).send({ error: "catalog entry not found" });
    if (existing) fireChange(wid, existing.kind);
    return reply.code(204).send();
  });
}
