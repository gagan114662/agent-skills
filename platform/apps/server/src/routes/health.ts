import type { FastifyInstance } from "fastify";
import type { HealthResponse } from "@reload/shared";
import { pingDb } from "../db/index.js";
import { pingRedis } from "../redis/index.js";

/**
 * GET /healthz — liveness + dependency readiness.
 * Returns 200 with status "ok" when all deps are up, "degraded" otherwise.
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
}
