import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import type { BuildLoopEngine } from "../build-loop/engine.js";

/**
 * Self-Shipping Loop routes (#172, ADR-0172) under `/workspaces/:wid/build-loop`. Thin adapters over
 * {@link BuildLoopEngine} — identity + the #19 `assertWorkspace` IDOR boundary, then a single engine
 * call. Recording an agent-ok issue + reading the runs are always available; the tick dispatches builds,
 * auto-reviews, and auto-merges within guardrails (or escalates). Default-OFF: a disabled workspace's
 * tick is a no-op (the engine returns `skipped: "disabled"`).
 */
export interface BuildLoopRoutesOptions {
  engine: BuildLoopEngine;
}

export async function buildLoopRoutes(app: FastifyInstance, opts: BuildLoopRoutesOptions): Promise<void> {
  const { engine } = opts;

  /** Record (or re-affirm) an agent-ok issue as a queued run — the explicit ingest path. */
  app.post("/workspaces/:wid/build-loop/issues", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as {
      issueRef?: string;
      issueTitle?: string;
      priority?: number;
      dependsOn?: string | null;
      agentOk?: boolean;
      targetChannelId?: string | null;
      targetAgentMemberId?: string | null;
    };
    if (!body.issueRef) return reply.code(400).send({ error: "issueRef is required" });
    if (!body.issueTitle) return reply.code(400).send({ error: "issueTitle is required" });
    const run = await engine.recordIssue(wid, {
      issueRef: body.issueRef,
      issueTitle: body.issueTitle,
      priority: typeof body.priority === "number" ? body.priority : 0,
      dependsOn: body.dependsOn ?? null,
      agentOk: body.agentOk ?? false,
      targetChannelId: body.targetChannelId ?? null,
      targetAgentMemberId: body.targetAgentMemberId ?? null,
    });
    return reply.code(201).send(run);
  });

  /** The recent runs (queue / in-flight / merge history / escalations) for the workspace. */
  app.get("/workspaces/:wid/build-loop/runs", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return engine.listRuns(wid);
  });

  /** Run one self-shipping pass: ingest → advance in-flight runs → dispatch queued issues under the cap. */
  app.post("/workspaces/:wid/build-loop/tick", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const result = await engine.tickWorkspace(wid, new Date());
    return reply.code(200).send(result);
  });

  /** Rebase-train: a main move asks every open PR to merge-from-main (conflicts route back to build). */
  app.post("/workspaces/:wid/build-loop/main-moved", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    await engine.onMainMoved(wid);
    return reply.code(202).send({ ok: true });
  });
}
