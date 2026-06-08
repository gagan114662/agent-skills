import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { newId } from "./db/id.js";
import { registerObservability } from "./observability/plugin.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { agentInterfaceRoutes } from "./routes/agent-interface.js";
import { agentRoutes } from "./routes/agents.js";
import { channelRoutes } from "./routes/channels.js";
import { notificationRoutes } from "./routes/notifications.js";
import { memoryRoutes } from "./routes/memory.js";
import { taskRoutes } from "./routes/tasks.js";
import { agentSessionRoutes } from "./routes/agent-sessions.js";
import { autonomyRoutes } from "./routes/autonomy.js";
import { searchRoutes } from "./routes/search.js";
import { attachRealtime } from "./realtime/gateway.js";
import { createDefaultSessionManager } from "./runtime/default.js";
import type { SessionManager } from "./runtime/manager.js";
import { createDefaultAutonomyEngine } from "./autonomy/default.js";
import type { AutonomyEngine } from "./autonomy/engine.js";

declare module "fastify" {
  interface FastifyInstance {
    /** The #17 autonomy engine; `index.ts` starts its opt-in background timer. */
    autonomyEngine: AutonomyEngine;
  }
}

/**
 * Builds the Fastify app without binding a port, so it can be exercised in tests
 * via `app.inject(...)`. `src/index.ts` calls `listen`.
 *
 * Correlation (#19): `requestIdHeader` makes Fastify adopt an inbound `x-request-id`
 * for traceability across services; `genReqId` falls back to a uuidv7. The id is
 * stamped on every log line (`requestIdLogLabel`) and echoed in the response header
 * by the observability plugin.
 */
/** Options for {@link buildApp}; tests may inject a SessionManager with a fake runtime (#25). */
export interface BuildAppOptions {
  sessionManager?: SessionManager;
  /** Tests inject an AutonomyEngine and drive `tick()` deterministically (#17). */
  autonomyEngine?: AutonomyEngine;
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
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
  // #11 framework-agnostic agent interface: GET /me/channels (capability-filtered) + GET /openapi.json.
  app.register(agentInterfaceRoutes);
  app.register(agentRoutes);
  app.register(channelRoutes);
  app.register(notificationRoutes);
  app.register(memoryRoutes);
  app.register(taskRoutes);
  app.register(searchRoutes);
  // #25 cloud agent execution: the SessionManager owns the agent run server-side (close the
  // laptop, agents keep working). Default backend is `local`; tests may inject a fake-runtime
  // manager. It is cancelled+drained on server close so no run leaks past shutdown.
  const sessionManager = opts.sessionManager ?? createDefaultSessionManager(app.log);
  app.register(agentSessionRoutes, { sessionManager });
  app.addHook("onClose", async () => {
    await sessionManager.shutdown();
  });
  // #17 autonomy: the AutonomyEngine drives the server-owned activity loop (pools, workflows,
  // handoffs, approval gates, guards + kill switch). The background timer is opt-in
  // (AUTONOMY_INTERVAL_MS, default off) and started in index.ts; tests inject the engine and
  // drive `tick()`. It is stopped on server close so no timer leaks past shutdown.
  const autonomyEngine = opts.autonomyEngine ?? createDefaultAutonomyEngine(app.log);
  app.register(autonomyRoutes, { engine: autonomyEngine });
  app.addHook("onClose", async () => {
    autonomyEngine.stop();
  });
  app.decorate("autonomyEngine", autonomyEngine);
  // #5 realtime gateway: WebSocket delivery + presence on top of the REST endpoints.
  // Its Redis subscriber is created lazily on the first socket, so inject-only tests
  // and the no-Redis CI job stay Redis-free.
  attachRealtime(app);
  return app;
}
