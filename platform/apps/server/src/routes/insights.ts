import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { InsightMiner, InsightNotFoundError } from "../insight/service.js";
import { INSIGHT_SOURCE_KINDS } from "../db/schema/insights.js";
import type { EvidenceRef, SourceKind } from "../insight/types.js";

/**
 * Insight Miner routes (#100): the ranked source list, owner-secret intake, mining, the pipeline view,
 * and promotion to a #96 venture idea — under `/workspaces/:wid/...`. Thin adapters over
 * {@link InsightMiner}: identity + the #19 `assertWorkspace` IDOR boundary, then a single service call.
 */
export interface InsightRoutesOptions {
  miner: InsightMiner;
}

/** Parse an optional ISO timestamp, returning undefined when absent and null when invalid. */
function parseDate(value: unknown): Date | undefined | null {
  if (value === undefined || value === null) return undefined;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseEvidence(value: unknown): EvidenceRef[] {
  if (!Array.isArray(value)) return [];
  return value.map((e) => {
    const row = (e ?? {}) as Record<string, unknown>;
    const observed = parseDate(row.observedAt);
    return {
      sourceUrl: typeof row.sourceUrl === "string" ? row.sourceUrl : null,
      excerpt: typeof row.excerpt === "string" ? row.excerpt : "",
      observedAt: observed instanceof Date ? observed : new Date(),
      sourceId: typeof row.sourceId === "string" ? row.sourceId : null,
    };
  });
}

export async function insightRoutes(app: FastifyInstance, opts: InsightRoutesOptions): Promise<void> {
  const { miner } = opts;

  /** "List is the strategy": register a candidate source (ranked by evidence strength before mining). */
  app.post("/workspaces/:wid/insight-sources", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = body.kind as SourceKind;
    if (!kind || !INSIGHT_SOURCE_KINDS.includes(kind)) {
      return reply.code(400).send({ error: `kind must be one of ${INSIGHT_SOURCE_KINDS.join(", ")}` });
    }
    const observedAt = parseDate(body.observedAt);
    if (observedAt === null) return reply.code(400).send({ error: "observedAt must be a valid date" });

    const source = await miner.addSource(
      wid,
      {
        kind,
        url: typeof body.url === "string" ? body.url : null,
        title: typeof body.title === "string" ? body.title : "",
        observedAt: observedAt ?? new Date(),
      },
      id.memberId,
    );
    return reply.code(201).send(source);
  });

  /** The ranked candidate source list. */
  app.get("/workspaces/:wid/insight-sources", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return reply.send(await miner.listSources(wid));
  });

  /** #100 scope 3: owner-secret intake — a first-class, ungated idea artifact. */
  app.post("/workspaces/:wid/insights/owner-secret", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const statement = body.statement;
    if (typeof statement !== "string" || statement.trim() === "") {
      return reply.code(400).send({ error: "statement is required" });
    }
    const painIntensity = Number(body.painIntensity ?? 0);
    const competitionAbsence = Number(body.competitionAbsence ?? 0);
    const observedAt = parseDate(body.observedAt);
    if (observedAt === null) return reply.code(400).send({ error: "observedAt must be a valid date" });

    const insight = await miner.captureOwnerSecret(
      wid,
      {
        statement,
        painIntensity,
        competitionAbsence,
        observedAt: observedAt ?? undefined,
        evidence: parseEvidence(body.evidence),
      },
      id.memberId,
    );
    return reply.code(201).send(insight);
  });

  /** #100 scope 1+2: run a mining pass (gated). Budget-exhausted answers 402 (the venture-loop semantics). */
  app.post("/workspaces/:wid/insights/mine", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const result = await miner.mine(wid, id.memberId);
    if (result.skipped === "budget") return reply.code(402).send(result);
    return reply.send(result);
  });

  /** The pipeline view: every insight, highest-score first. */
  app.get("/workspaces/:wid/insights", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return reply.send(await miner.listInsights(wid));
  });

  /** Read one insight + its provenance evidence. */
  app.get("/workspaces/:wid/insights/:iid", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, iid } = req.params as { wid: string; iid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    try {
      return reply.send(await miner.get(wid, iid));
    } catch (err) {
      if (err instanceof InsightNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  /** Promote an insight to a #96 venture idea (provenance-linked). A killed-uncited angle is suppressed. */
  app.post("/workspaces/:wid/insights/:iid/promote", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, iid } = req.params as { wid: string; iid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const { targetUser, wedge, marketPath } = body;
    if (typeof targetUser !== "string" || typeof wedge !== "string" || typeof marketPath !== "string") {
      return reply.code(400).send({ error: "targetUser, wedge, marketPath are all required" });
    }
    try {
      const result = await miner.promote(
        wid,
        iid,
        { targetUser, wedge, marketPath, problem: typeof body.problem === "string" ? body.problem : undefined },
        id.memberId,
      );
      return reply.code(result.suppressed ? 409 : 201).send(result);
    } catch (err) {
      if (err instanceof InsightNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  /** Kill an insight — records the angle to the #15 memory graph so it never returns uncited. */
  app.post("/workspaces/:wid/insights/:iid/kill", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, iid } = req.params as { wid: string; iid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reasoning = typeof body.reasoning === "string" ? body.reasoning : "killed by operator";
    try {
      await miner.kill(wid, iid, reasoning, id.memberId);
      return reply.send({ ok: true });
    } catch (err) {
      if (err instanceof InsightNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });
}
