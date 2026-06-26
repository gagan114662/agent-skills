import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import type { CandidateRecord } from "../venture-factory/types.js";
import type { VentureFactoryService } from "../venture-factory/service.js";
import { VentureFactoryDisabledError } from "../venture-factory/service.js";

export interface VentureFactoryRoutesOptions {
  service: VentureFactoryService;
}

function parseDate(value: unknown): Date | undefined | null {
  if (value === undefined || value === null) return undefined;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toCandidateDto(candidate: CandidateRecord) {
  return {
    id: candidate.id,
    workspaceId: candidate.workspaceId,
    source: candidate.source,
    thesis: candidate.thesis,
    proposedName: candidate.proposedName,
    evidence: {
      painIntensity: candidate.painIntensity,
      competitionAbsence: candidate.competitionAbsence,
      observedAt: candidate.observedAt.toISOString(),
      citations: candidate.citations,
    },
    score: candidate.score,
    edgeClaims: candidate.edgeClaims,
    edgeStatus: candidate.edgeStatus,
    status: candidate.status,
    createdByMemberId: candidate.createdByMemberId,
    createdAt: candidate.createdAt.toISOString(),
  };
}

/**
 * Venture Factory intake routes (#1060). These routes ingest untrusted external opportunity data into the
 * existing factory candidate table; they do not execute, send, spend, or publish.
 */
export async function ventureFactoryRoutes(
  app: FastifyInstance,
  opts: VentureFactoryRoutesOptions,
): Promise<void> {
  app.post("/me/venture-factory/opportunities", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const observedAt = parseDate(body.observedAt);
    if (observedAt === null) return reply.code(400).send({ error: "observedAt must be a valid date" });
    if (typeof body.title !== "string" || body.title.trim().length === 0) {
      return reply.code(400).send({ error: "title is required" });
    }
    if (typeof body.sourceUrl !== "string" || body.sourceUrl.trim().length === 0) {
      return reply.code(400).send({ error: "sourceUrl is required" });
    }

    try {
      const candidate = await opts.service.ingestExternalPaidOpportunity(id.workspaceId, {
        title: body.title,
        sourceUrl: body.sourceUrl,
        buyer: typeof body.buyer === "string" ? body.buyer : undefined,
        compensation: typeof body.compensation === "string" ? body.compensation : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        observedAt: observedAt ?? undefined,
        createdByMemberId: id.memberId,
      });
      return reply.code(201).send({ opportunity: toCandidateDto(candidate) });
    } catch (err) {
      if (err instanceof VentureFactoryDisabledError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });
}
