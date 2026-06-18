import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { createDefaultDepartmentService } from "../department/default.js";

/**
 * Named-department routes (#371, ADR-0371) — the reload.chat "team" surface: the named personas (roles +
 * handles + colors), their #282 registry presence, and the members-rail footer
 * ("{n} humans · {n} agents · {n} decisions captured"). All `/me/*`-scoped to the caller's workspace (#3,
 * the httpOnly `rid` session cookie identifies it).
 *
 *  - `GET  /me/department` — the team: the roster (present/enabled per teammate) + the rail footer.
 *    Read-only; works regardless of the flag (`enabled`/`canManage` reflect it). Browse is always allowed.
 *  - `POST /me/department/seed` — idempotently seed the team (mint the identity personas). Human-only,
 *    owner-workspace-first + default-OFF: a 409 when out of scope; nothing is created. Re-running is safe.
 *
 * Default-OFF + owner-workspace-first: when the flag is off the roster still lists but the seed 409s, so a
 * deployment that sets nothing changes nothing. No send/spend and no new action path — seeding mints
 * identity/display personas only; every real action still flows through the #13 gate (#200).
 */
export async function departmentRoutes(app: FastifyInstance): Promise<void> {
  const service = createDefaultDepartmentService();

  // The team roster + the members-rail footer. Read-only; never a secret.
  app.get("/me/department", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return service.view({ workspaceId: id.workspaceId, memberId: id.memberId });
  });

  // Seed the team (idempotent). Owner-gated: out-of-scope/flag-off ⇒ 409, nothing created.
  app.post("/me/department/seed", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    if (id.kind !== "human") return reply.code(401).send({ error: "human authentication required" });
    const result = await service.seed({ workspaceId: id.workspaceId, memberId: id.memberId });
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    return reply.code(200).send({
      createdCount: result.createdCount,
      seeded: result.seeded,
      department: result.view,
    });
  });
}
