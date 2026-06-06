import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { agentRoutes } from "./routes/agents.js";
import { channelRoutes } from "./routes/channels.js";
import { attachRealtime } from "./realtime/gateway.js";

/**
 * Builds the Fastify app without binding a port, so it can be exercised in tests
 * via `app.inject(...)`. `src/index.ts` calls `listen`.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(cookie);
  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(meRoutes);
  app.register(agentRoutes);
  app.register(channelRoutes);
  // #5 realtime gateway: WebSocket delivery + presence on top of the REST endpoints.
  // Its Redis subscriber is created lazily on the first socket, so inject-only tests
  // and the no-Redis CI job stay Redis-free.
  attachRealtime(app);
  return app;
}
