import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import type { PreflightReport } from "../runtime/preflight.js";
import { defaultPreflight } from "../runtime/default.js";

export interface PreflightRoutesOptions {
  /** The preflight to run for this server (#69). Defaults to the live host-env check. */
  preflight?: () => PreflightReport;
}

/**
 * Preflight / doctor route (#69). `GET /preflight` runs the deployment's posture checks (cloud auth
 * + harness availability) against the live host env and returns the structured report — backing
 * `reload doctor`. It requires identity because the posture detail (which credentials are *present*)
 * is operational, not public; it still returns only variable **names** and statuses, never a secret
 * value. The report's own `ok` flag is the source of truth, so the HTTP status is always 200.
 */
export async function preflightRoutes(
  app: FastifyInstance,
  opts: PreflightRoutesOptions = {},
): Promise<void> {
  const run = opts.preflight ?? defaultPreflight;

  app.get("/preflight", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return run();
  });
}
