import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { createDefaultAssetService } from "../assets/default.js";

/**
 * Brand kit routes (#271, ADR-0271). The owner sets their brand identity ONCE here — logo (a soft ref to
 * an uploaded asset), colours (palette) and voice — and Mark enforces it; the other agents draw from it.
 * `/me/*`-scoped to the caller's workspace (#3). These are owner data writes: money-free and harmless, so
 * they are NOT behind the real-world master flag (unlike `generate_image`) — and setting a kit is exactly
 * what flips the founder-console brand proof tile to connected (#253).
 */
export async function brandKitRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me/brand-kit", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    const svc = createDefaultAssetService(wid);
    const [record, assetCount] = await Promise.all([svc.activeBrandKit(wid), svc.countAssets(wid)]);
    return {
      connected: record !== null,
      brandKit: record ? { id: record.id, ...record.kit } : null,
      assetCount,
    };
  });

  app.put("/me/brand-kit", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    const body = (req.body ?? {}) as {
      name?: unknown;
      palette?: unknown;
      voice?: unknown;
      logoAssetId?: unknown;
    };
    const svc = createDefaultAssetService(wid);
    const result = await svc.setBrandKit(wid, body);
    if (!result.ok) return reply.code(400).send({ error: result.errors.join("; "), errors: result.errors });
    return {
      connected: true,
      brandKit: { id: result.record.id, ...result.record.kit },
    };
  });
}
