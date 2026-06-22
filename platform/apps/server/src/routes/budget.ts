import type { FastifyInstance, FastifyReply } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { requireMemoryCapability } from "../auth/access.js";
import { resolveBudgetGovernorCaps } from "../budget/caps.js";
import { BudgetGovernorService, BudgetGovernorError } from "../budget/service.js";
import { createDefaultBudgetService } from "../budget/default.js";

export interface BudgetRoutesOptions {
  /** Tests inject a service over an in-memory store; the default wires the self-managed Postgres store. */
  service?: BudgetGovernorService;
}

/**
 * The spend-cap governor surface (issue #670). The READ endpoint returns the workspace's live spend
 * position (committed + projected vs the cap) and its pending cap-raises. The MUTATIONS are the human
 * governance controls: request a cap RAISE (parked pending — it does not take effect until approved),
 * approve/reject a pending raise (the recorded human approval), and lower the cap immediately. Every
 * mutation requires the workspace-administering (`propagate`) capability, so an agent can never raise or
 * approve its own ceiling — only a human can. The in-process enforcement primitives (`authorizeSpend`,
 * `settle`, `release`) are NOT exposed here; a spend site calls the service directly.
 *
 * Caps-gated: when the governor is disabled (the default, owner-workspace-first) every endpoint answers
 * `409` — enforcement is opt-in via `BUDGET_GOVERNOR_ENABLED`. Tenant-scoped via the #19 guard (#3 IDOR).
 */
export async function budgetRoutes(app: FastifyInstance, opts: BudgetRoutesOptions = {}): Promise<void> {
  const service = opts.service ?? createDefaultBudgetService(app.log);

  /** 409 unless the governor is enabled for this deployment. */
  function gate(reply: FastifyReply): boolean {
    if (!resolveBudgetGovernorCaps().enabled) {
      reply.code(409).send({ error: "spend cap governor is not enabled" });
      return false;
    }
    return true;
  }

  /** Map a governor rejection (invalid raise, missing/decided request) to 409 with its reason. */
  function fail(err: unknown, reply: FastifyReply): void {
    if (err instanceof BudgetGovernorError) {
      reply.code(409).send({ error: err.message });
      return;
    }
    throw err;
  }

  app.get("/workspaces/:wid/budget", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!gate(reply)) return;
    const [status, pendingRaises] = await Promise.all([
      service.status(wid),
      service.listRaises(wid, "pending"),
    ]);
    return { enabled: true, status, pendingRaises };
  });

  app.post("/workspaces/:wid/budget/cap/raise", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!(await requireMemoryCapability(id, wid, "propagate", reply))) return;
    if (!gate(reply)) return;
    const { toCents } = (req.body ?? {}) as { toCents?: number };
    try {
      const raise = await service.requestRaise(wid, id.memberId, Number(toCents));
      reply.code(201);
      return { raise };
    } catch (err) {
      return fail(err, reply);
    }
  });

  app.post("/workspaces/:wid/budget/cap/lower", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!(await requireMemoryCapability(id, wid, "propagate", reply))) return;
    if (!gate(reply)) return;
    const { toCents } = (req.body ?? {}) as { toCents?: number };
    const status = await service.lowerCap(wid, Number(toCents));
    return { status };
  });

  app.post("/workspaces/:wid/budget/raises/:rid/approve", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, rid } = req.params as { wid: string; rid: string };
    if (!(await requireMemoryCapability(id, wid, "propagate", reply))) return;
    if (!gate(reply)) return;
    const { reason } = (req.body ?? {}) as { reason?: string };
    try {
      return await service.approveRaise(wid, rid, id.memberId, reason ?? null);
    } catch (err) {
      return fail(err, reply);
    }
  });

  app.post("/workspaces/:wid/budget/raises/:rid/reject", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, rid } = req.params as { wid: string; rid: string };
    if (!(await requireMemoryCapability(id, wid, "propagate", reply))) return;
    if (!gate(reply)) return;
    const { reason } = (req.body ?? {}) as { reason?: string };
    try {
      return await service.rejectRaise(wid, rid, id.memberId, reason ?? null);
    } catch (err) {
      return fail(err, reply);
    }
  });
}
