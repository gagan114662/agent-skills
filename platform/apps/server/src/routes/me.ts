import type { FastifyInstance } from "fastify";
import { resolveIdentity } from "../auth/middleware.js";

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (req, reply) => {
    const identity = await resolveIdentity(req);
    if (!identity) return reply.code(401).send({ error: "unauthorized" });
    return identity;
  });
}
