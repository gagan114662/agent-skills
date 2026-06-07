import type { FastifyInstance } from "fastify";
import type { HealthResponse, LivenessResponse, ReadinessResponse } from "@reload/shared";
import { pingDb } from "../db/index.js";
import { pingRedis } from "../redis/index.js";

/**
 * Health & probe endpoints. None read tenant data, so all are unauthenticated —
 * safe for container probes and scrapers.
 *
 * - GET /healthz — human-facing summary (from #1): ok | degraded, always 200.
 * - GET /livez   — liveness: the process is up. Always 200. Container restart probe.
 * - GET /readyz  — readiness: deps reachable. 200 ready / 503 not_ready. Traffic gate.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async (): Promise<HealthResponse> => {
    const [db, redis] = await Promise.all([pingDb(), pingRedis()]);
    return {
      status: db && redis ? "ok" : "degraded",
      db: db ? "up" : "down",
      redis: redis ? "up" : "down",
    };
  });

  app.get("/livez", async (): Promise<LivenessResponse> => {
    return { status: "ok" };
  });

  app.get("/readyz", async (_req, reply): Promise<ReadinessResponse> => {
    const [db, redis] = await Promise.all([pingDb(), pingRedis()]);
    const ready = db && redis;
    reply.code(ready ? 200 : 503);
    return {
      status: ready ? "ready" : "not_ready",
      db: db ? "up" : "down",
      redis: redis ? "up" : "down",
    };
  });
}
