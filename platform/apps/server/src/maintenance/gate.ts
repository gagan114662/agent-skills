import type { FastifyInstance } from "fastify";
import { getMaintenanceState } from "./flag.js";
import { shouldRejectWrite, type MaintenanceState } from "./policy.js";

export interface MaintenanceGateOptions {
  /** State reader (tests inject a fake); defaults to the Redis-backed flag. */
  readState?: () => Promise<MaintenanceState>;
  /** Seconds advertised in the `Retry-After` header on a rejected write. */
  retryAfterSeconds?: number;
}

/**
 * Install the maintenance write-gate (#99, ADR-0099). Added directly on the root app (NOT via
 * `app.register`) — exactly like {@link registerObservability} — so the hook covers every route
 * plugin; a registered plugin would encapsulate the hook to its own scope.
 *
 * On every request it reads the maintenance flag (per-request, so a flip takes effect in seconds with
 * no redeploy) and, for a non-allow-listed write while maintenance is on, replies `503 + Retry-After`.
 * Reads always pass. The read **fails open**: an unavailable backing store admits everything.
 */
export function registerMaintenance(app: FastifyInstance, opts: MaintenanceGateOptions = {}): void {
  const readState = opts.readState ?? (() => getMaintenanceState());
  const retryAfter = String(opts.retryAfterSeconds ?? 30);

  app.addHook("onRequest", async (req, reply) => {
    const routePath = req.routeOptions?.url ?? req.url;
    const state = await readState();
    if (shouldRejectWrite(state, req.method, routePath)) {
      reply.header("retry-after", retryAfter);
      await reply.code(503).send({
        error: "maintenance",
        reason: state.reason ?? "the platform is in maintenance mode; writes are paused",
      });
    }
  });
}
