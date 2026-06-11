import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import type { EvalService } from "../evals/service.js";
import { loadSuite, listSuiteAgents } from "../evals/loader.js";
import { listEvalRuns } from "../db/repositories/evals.js";

/**
 * Eval-maintenance routes (#155, ADR-0155 §4) under `/workspaces/:wid/evals`. Thin adapters over
 * {@link EvalService} — identity + the #19 `assertWorkspace` IDOR boundary, then a single service call. The
 * suites are the offline corpora on disk; running one grades + persists an `eval_runs` row, traces it, and
 * (when the proactive posture is enabled) feeds a regression to the #117 flywheel. Reads list the audit
 * trail. No model spend — the suites are deterministic.
 */
export interface EvalRoutesOptions {
  service: EvalService;
}

export async function evalRoutes(app: FastifyInstance, opts: EvalRoutesOptions): Promise<void> {
  const { service } = opts;

  /** The agent domains that have an eval suite. */
  app.get("/workspaces/:wid/evals", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return { agents: listSuiteAgents() };
  });

  /** Run one agent's offline eval suite: grade → persist → trace → (gated) flywheel feed. */
  app.post("/workspaces/:wid/evals/:agent/run", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, agent } = req.params as { wid: string; agent: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!listSuiteAgents().includes(agent)) {
      return reply.code(404).send({ error: `no eval suite for agent: ${agent}` });
    }
    const outcome = await service.runSuite(wid, loadSuite(agent));
    return reply.code(201).send(outcome);
  });

  /** The eval-run audit trail for this workspace (newest first), optionally filtered to one agent. */
  app.get("/workspaces/:wid/evals/runs", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    // A repeated query param (?agent=a&agent=b) arrives as an array — only a single string is a valid
    // filter; anything else (array/missing) means "no filter" rather than crashing Drizzle's eq().
    const rawAgent = (req.query as { agent?: unknown }).agent;
    const agent = typeof rawAgent === "string" ? rawAgent : undefined;
    return { runs: await listEvalRuns(wid, agent) };
  });
}
