import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const AUTH_PUBLIC_RATE_LIMIT = {
  max: 8,
  timeWindow: "1 minute",
  windowMs: 60_000,
} as const;

export const SIGNUP_PUBLIC_RATE_LIMIT = {
  max: 100,
  timeWindow: "1 minute",
  windowMs: 60_000,
} as const;

export const INBOUND_LEAD_PUBLIC_RATE_LIMIT = {
  max: 5,
  timeWindow: "1 hour",
  windowMs: 3_600_000,
} as const;

export function registerPublicRateLimits(app: FastifyInstance): void {
  app.register(rateLimit, {
    global: true,
    max: 10_000,
    timeWindow: "1 minute",
    hook: "preHandler",
    errorResponseBuilder: () => ({
      error: "rate limit exceeded",
    }),
  });
}

export function publicRateLimitPreHandler(limit: {
  max: number;
  windowMs: number;
}): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return async (req, reply) => {
    const now = Date.now();
    const key = req.ip;
    const current = hits.get(key);
    const bucket =
      current && current.resetAt > now ? current : { count: 0, resetAt: now + limit.windowMs };
    bucket.count += 1;
    hits.set(key, bucket);
    if (bucket.count <= limit.max) return;
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    reply.header("retry-after", String(retryAfter)).code(429).send({ error: "rate limit exceeded" });
  };
}
