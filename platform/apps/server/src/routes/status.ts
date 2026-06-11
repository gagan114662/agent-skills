import type { FastifyInstance } from "fastify";
import { pingDb } from "../db/index.js";
import { pingRedis } from "../redis/index.js";
import { getWorkspaceBySlug } from "../db/repositories/workspaces.js";
import { listIncidents } from "../db/repositories/sre.js";
import { loadConfig } from "../config/loader.js";
import { resolveReliabilityCaps } from "../reliability/caps.js";
import { composeStatusPage } from "../reliability/status/compose.js";

/**
 * The PUBLIC status page (#148, ADR-0148): `GET /status/:slug` — UNAUTHENTICATED, like the health
 * probes. It resolves the workspace by its existing slug and **404s unless that workspace opted in**
 * (`reliability.statusPageEnabled`), so default-OFF means nothing is exposed. Component health comes
 * from the same `pingDb`/`pingRedis` `/readyz` uses; the incident history is **redacted** by
 * `composeStatusPage` (service/severity/status/timestamps only — never observed/target internals)
 * because the boundary is public. Per-venture pages are a later use of the same slug seam.
 */
export async function statusRoutes(app: FastifyInstance): Promise<void> {
  app.get("/status/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const ws = await getWorkspaceBySlug(slug);
    if (!ws || !resolveReliabilityCaps(loadConfig(ws.id).reliability).statusPageEnabled) {
      reply.code(404);
      return { error: "status page not found" };
    }

    const [db, redis, incidents] = await Promise.all([
      pingDb(),
      pingRedis(),
      listIncidents(ws.id, { limit: 20 }),
    ]);

    return composeStatusPage({
      workspaceName: ws.name,
      components: [
        { name: "api", healthy: db && redis },
        { name: "database", healthy: db },
        { name: "cache", healthy: redis },
      ],
      incidents: incidents.map((i) => ({
        service: i.service,
        sloKind: i.sloKind,
        severity: i.severity,
        status: i.status,
        openedAt: i.openedAt,
        resolvedAt: i.resolvedAt,
      })),
      now: new Date(),
    });
  });
}
