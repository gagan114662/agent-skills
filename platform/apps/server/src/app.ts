import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "./routes/health.js";

/**
 * Builds the Fastify app without binding a port, so it can be exercised in tests
 * via `app.inject(...)`. `src/index.ts` calls `listen`.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(healthRoutes);
  return app;
}
