import type { FastifyInstance } from "fastify";

export interface CorsOptions {
  /**
   * Exact-match allowlist of web origins permitted to make credentialed (cookie) requests.
   * Tests inject this; the default reads `RELOAD_WEB_ORIGIN` (comma-separated) from the environment.
   */
  allowedOrigins?: string[];
}

/** Parse `RELOAD_WEB_ORIGIN` ("https://ipop.ai,https://www.ipop.ai") into a trimmed, non-empty list. */
export function parseEnvOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.RELOAD_WEB_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Dependency-free CORS for the split deployment (#108): the web console (https://ipop.ai) calls the
 * API (https://api.ipop.ai). Same registrable site — so the `sameSite: "lax"` session cookie is sent
 * — but a different *origin*, so the browser still needs explicit CORS headers to use the response of
 * a credentialed `fetch`. Installed directly on the root like {@link registerMaintenance} so it
 * covers every route (a registered plugin would encapsulate the hook to its own scope).
 *
 * No-op when no origins are configured, preserving the same-origin/local-dev behavior. Credentialed
 * CORS forbids a wildcard origin, so we reflect the request `Origin` only when it's allow-listed and
 * always set `Vary: Origin` so shared caches never serve one origin's response to another. A preflight
 * `OPTIONS` is answered with `204` and the method/header allowances.
 */
export function registerCors(app: FastifyInstance, opts: CorsOptions = {}): void {
  const allowed = new Set(opts.allowedOrigins ?? parseEnvOrigins());
  if (allowed.size === 0) return;

  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      reply.header("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      const requested = req.headers["access-control-request-headers"];
      reply.header(
        "access-control-allow-headers",
        typeof requested === "string" && requested ? requested : "content-type",
      );
      reply.header("access-control-max-age", "600");
      // Short-circuit the preflight (same mechanism the maintenance gate uses to stop the chain).
      await reply.code(204).send();
    }
  });
}
