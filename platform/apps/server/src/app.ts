import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { newId } from "./db/id.js";
import { registerObservability } from "./observability/plugin.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { agentRoutes } from "./routes/agents.js";
import { channelRoutes } from "./routes/channels.js";
import { searchRoutes } from "./routes/search.js";
import { attachRealtime } from "./realtime/gateway.js";

/**
 * Builds the Fastify app without binding a port, so it can be exercised in tests
 * via `app.inject(...)`. `src/index.ts` calls `listen`.
 *
 * Correlation (#19): `requestIdHeader` makes Fastify adopt an inbound `x-request-id`
 * for traceability across services; `genReqId` falls back to a uuidv7. The id is
 * stamped on every log line (`requestIdLogLabel`) and echoed in the response header
 * by the observability plugin.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: true,
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "requestId",
    genReqId: () => newId(),
  });
  app.register(cookie);
  registerObservability(app);
  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(meRoutes);
  app.register(agentRoutes);
  app.register(channelRoutes);
  app.register(searchRoutes);
  // #5 realtime gateway: WebSocket delivery + presence on top of the REST endpoints.
  // Its Redis subscriber is created lazily on the first socket, so inject-only tests
  // and the no-Redis CI job stay Redis-free.
  attachRealtime(app);
  return app;
}
