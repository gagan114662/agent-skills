import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    return identity;
  });
}
