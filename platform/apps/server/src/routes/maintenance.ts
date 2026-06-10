import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { getMaintenanceState, setMaintenance } from "../maintenance/flag.js";

/**
 * Maintenance-mode control (#99, ADR-0099). Backs the `reload maintenance on|off|status` CLI.
 *
 * - `GET  /maintenance` — current state (enabled + since/reason/by).
 * - `POST /maintenance { on: boolean, reason?: string }` — flip the flag.
 *
 * Both require an authenticated identity (an operator action; the flip is recorded with the member
 * id). This route is on the gate's allow-list (see `maintenance/policy.ts`), so you can always turn
 * maintenance back OFF while it is on. The destructive *restore* is gated separately by the #13
 * `dr.restore` approval — flipping the maintenance flag is intentionally lightweight so an operator
 * can take the platform read-only in seconds.
 */
export async function maintenanceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/maintenance", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return getMaintenanceState();
  });

  app.post<{ Body: { on?: boolean; reason?: string } }>("/maintenance", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { on, reason } = req.body ?? {};
    if (typeof on !== "boolean") {
      return reply.code(400).send({ error: "body.on must be a boolean" });
    }
    const state = await setMaintenance(on, { reason, by: id.memberId });
    req.log.warn({ on, by: id.memberId, reason }, "maintenance mode flipped");
    return state;
  });
}
