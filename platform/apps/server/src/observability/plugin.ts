import type { FastifyInstance } from "fastify";
import { resolveIdentity } from "../auth/middleware.js";
import {
  incInFlight,
  decInFlight,
  recordRequest,
  renderMetrics,
  setSaturationSample,
} from "./metrics.js";
import { collectSaturation, type SaturationCollectorDeps } from "./saturation.js";

export interface ObservabilityOptions {
  /**
   * Saturation sources (#113) sampled at scrape time. When omitted, `/metrics` renders activity series
   * only (back-compat: existing tests call `registerObservability(app)` with no saturation wiring).
   */
  saturation?: SaturationCollectorDeps;
}

/** Bound a saturation sample so a scrape never hangs on a slow dependency. Resolves null on timeout. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
export function registerObservability(app: FastifyInstance, opts: ObservabilityOptions = {}): void {
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
    // #113: sample the saturation signals at scrape time, fail-soft. A slow/dead dependency must never
    // hang or fail the scrape — on timeout/error we keep the last sample (or none) and render anyway.
    if (opts.saturation) {
      try {
        const sample = await withTimeout(collectSaturation(opts.saturation), 500);
        if (sample) setSaturationSample(sample);
      } catch {
        /* fail-soft: keep the last sample (or none) and render anyway — never fail the scrape */
      }
    }
    return renderMetrics();
  });
}
