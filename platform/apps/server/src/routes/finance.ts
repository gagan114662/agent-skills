import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { loadConfig } from "../config/loader.js";
import { resolveFinanceCaps } from "../finance/caps.js";
import type { FinanceService } from "../finance/service.js";

export interface FinanceRoutesOptions {
  service: FinanceService;
}

/**
 * The Finance Ledger read surface (#194, ADR-0194): the per-venture ledger, the closed monthly books,
 * the runway forecast, and a CSV period statement for the human accountant. Tenant-scoped via the #19
 * guard (`assertWorkspace`) so a caller only sees their own tenant's books. **Caps-gated:** when
 * `finance.enabled` is OFF (the default, owner-workspace-first) every endpoint answers `409` — the
 * accounting layer is opt-in. NO mutation endpoints: money decisions flow through the #13 queue, never
 * here, and nothing here moves money.
 */
export async function financeRoutes(app: FastifyInstance, opts: FinanceRoutesOptions): Promise<void> {
  /** 409 unless the workspace has opted into the finance layer. Returns the resolved caps when enabled. */
  function gate(wid: string, reply: import("fastify").FastifyReply): boolean {
    if (!resolveFinanceCaps(loadConfig(wid).finance).enabled) {
      reply.code(409).send({ error: "finance ledger is not enabled for this workspace" });
      return false;
    }
    return true;
  }

  app.get("/workspaces/:wid/finance/ledger", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!gate(wid, reply)) return;
    const q = req.query as { venture?: string; period?: string };
    const ventureIdeaId = q.venture === "workspace" ? null : q.venture;
    const entries = await opts.service.ledger(wid, { ventureIdeaId, periodKey: q.period });
    return { entries };
  });

  app.get("/workspaces/:wid/finance/close", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!gate(wid, reply)) return;
    const q = req.query as { period?: string };
    const closePacks = await opts.service.closePacks(wid, { periodKey: q.period });
    return { closePacks };
  });

  app.get("/workspaces/:wid/finance/runway", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!gate(wid, reply)) return;
    return opts.service.runway(wid);
  });

  app.get("/workspaces/:wid/finance/export.csv", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!gate(wid, reply)) return;
    const q = req.query as { period?: string; kind?: string };
    const csv =
      q.kind === "close"
        ? await opts.service.exportCloseCsv(wid, q.period)
        : await opts.service.exportLedgerCsv(wid, q.period);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="finance-${q.kind ?? "ledger"}.csv"`);
    return reply.send(csv);
  });
}
