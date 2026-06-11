import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import type { MoatService } from "../moat/service.js";
import { MOAT_DIMENSIONS, type MoatAccrual, type MoatDimension } from "../moat/types.js";

/**
 * Moat Accrual routes (#103): record an accrual + read a venture's moat score/stagnation under
 * `/workspaces/:wid/ventures/:vid/moat`, and the portfolio roll-up under `/workspaces/:wid/moat`.
 * Thin adapters over {@link MoatService} — identity + the #19 `assertWorkspace` IDOR boundary, then a
 * single service call. The moat score is the read surface the Venture scorecard (#96) + the portfolio
 * tick (#107) consume; the portfolio list is what the Founder Console (#104) flags stagnant ventures on.
 */
export interface MoatRoutesOptions {
  service: MoatService;
  /** Resolve the workspace's venture idea ids (so the portfolio scores zero-accrual ventures too). */
  ventureIds: (workspaceId: string) => Promise<string[]>;
}

function isDimension(v: unknown): v is MoatDimension {
  return typeof v === "string" && (MOAT_DIMENSIONS as readonly string[]).includes(v);
}

export async function moatRoutes(app: FastifyInstance, opts: MoatRoutesOptions): Promise<void> {
  const { service, ventureIds } = opts;

  /** Record one concrete moat accrual against a venture. */
  app.post("/workspaces/:wid/ventures/:vid/moat", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, vid } = req.params as { wid: string; vid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as Partial<MoatAccrual>;
    if (!isDimension(body.dimension)) {
      return reply
        .code(400)
        .send({ error: `dimension must be one of: ${MOAT_DIMENSIONS.join(", ")}` });
    }
    if (typeof body.magnitude !== "number" || !Number.isFinite(body.magnitude) || body.magnitude < 0) {
      return reply.code(400).send({ error: "magnitude must be a number >= 0" });
    }
    if (!body.unit || !body.provenance) {
      return reply.code(400).send({ error: "unit and provenance are required" });
    }
    const accrual: MoatAccrual = {
      dimension: body.dimension,
      magnitude: body.magnitude,
      unit: body.unit,
      description: body.description ?? "",
      provenance: body.provenance,
      sourceRef: body.sourceRef ?? null,
    };
    const entry = await service.record(wid, vid, accrual, id.memberId);
    return reply.code(201).send(entry);
  });

  /** Read a venture's moat score + stagnation assessment — the #96/#107 read surface. */
  app.get("/workspaces/:wid/ventures/:vid/moat", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, vid } = req.params as { wid: string; vid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return reply.send(await service.scoreVenture(wid, vid));
  });

  /** The portfolio moat roll-up: every venture's score + stagnant flag. */
  app.get("/workspaces/:wid/moat", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const ids = await ventureIds(wid);
    return reply.send(await service.portfolioMoat(wid, ids));
  });
}
