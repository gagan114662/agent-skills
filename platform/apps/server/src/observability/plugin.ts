import type { FastifyInstance } from "fastify";
import { resolveIdentity } from "../auth/middleware.js";
import { incInFlight, decInFlight, recordRequest, renderMetrics } from "./metrics.js";

/**
 * Install observability (#19): correlation, tenant-attributed logging, metrics.
 *
 * Called directly on the root app (NOT via `app.register`) so the hooks apply to
 * every route — a registered Fastify plugin would encapsulate the hooks to its own
 * scope and leave sibling route plugins untouched.
 *
 * - `onRequest`  — echo the correlation id (`x-request-id`, set up via `genReqId`
 *   in app.ts) and any W3C `traceparent` so a request is traceable end-to-end;
 *   mark it in-flight.
 * - `preHandler` — resolve the caller once (memoized on the request, so routes
 *   re-using `resolveIdentity` don't pay a second DB lookup) and bind
 *   `{ workspaceId, memberId, kind }` to the request log child, so EVERY log line
 *   for the request is tenant-attributed.
 * - `onResponse` — record metrics by route template (not raw path) and clear
 *   in-flight.
 * - `GET /metrics` — Prometheus text exposition (no auth, no tenant data).
 */
export function registerObservability(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    incInFlight();
    reply.header("x-request-id", req.id);
    const traceparent = req.headers["traceparent"];
    if (typeof traceparent === "string" && traceparent.length > 0) {
      reply.header("traceparent", traceparent);
    }
  });

  app.addHook("preHandler", async (req) => {
    const identity = await resolveIdentity(req);
    if (identity) {
      req.log = req.log.child({
        workspaceId: identity.workspaceId,
        memberId: identity.memberId,
        kind: identity.kind,
      });
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    decInFlight();
    const route = req.routeOptions?.url ?? "unknown";
    recordRequest(req.method, route, reply.statusCode, reply.elapsedTime / 1000);
  });

  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return renderMetrics();
  });
}
