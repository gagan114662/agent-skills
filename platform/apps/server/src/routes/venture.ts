import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { VentureService, VentureNotFoundError } from "../venture/service.js";
import type { IdeaInput } from "../venture/types.js";
import { loadConfig } from "../config/loader.js";
import { resolveVentureIntakeCaps, ventureIntakeActive } from "../venture-intake/caps.js";

/**
 * Venture Loop routes (#96): submit / score / decide / get under `/workspaces/:wid/ventures`. Thin
 * adapters over {@link VentureService} — identity + the #19 `assertWorkspace` IDOR boundary, then a
 * single service call. All logic (evidence, scoring, the pure gate, side effects) lives in the
 * service; a missing idea/scorecard surfaces as a 404.
 */
export interface VentureRoutesOptions {
  service: VentureService;
}

export async function ventureRoutes(
  app: FastifyInstance,
  opts: VentureRoutesOptions,
): Promise<void> {
  const { service } = opts;

  /**
   * #96 step 1 SOURCE: submit the typed intake artifact.
   *
   * #387 venture-intake gate (default OFF, owner-workspace-first): this is the owner-facing brief submit
   * path that lets the owner brief ANY company idea into the existing venture loop. When `ventureIntake`
   * is NOT active for the workspace the route answers 409 (the surface is opt-in, mirroring the finance /
   * attribution routes). With the flag unset (default / prod non-owner) the brief path is closed, so prod
   * is byte-for-byte unchanged. The score/decide/advance/get routes below keep their existing behavior.
   * Adds NO money path — submit + heuristic score + epic emission are existing non-money paths.
   */
  app.post("/workspaces/:wid/ventures", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const intakeCaps = resolveVentureIntakeCaps(loadConfig(wid).ventureIntake);
    if (!ventureIntakeActive(intakeCaps, wid)) {
      return reply
        .code(409)
        .send({ error: "venture intake is not enabled for this workspace" });
    }

    const body = (req.body ?? {}) as Partial<IdeaInput>;
    const { problem, targetUser, insight, wedge, marketPath, segment } = body;
    if (!problem || !targetUser || !insight || !wedge || !marketPath) {
      return reply
        .code(400)
        .send({ error: "problem, targetUser, insight, wedge, marketPath are all required" });
    }
    // #146: optional go-to-market segment — only 'b2b' | 'b2c' (null/absent ⇒ no segment).
    if (segment != null && segment !== "b2b" && segment !== "b2c") {
      return reply.code(400).send({ error: "segment, when present, must be 'b2b' or 'b2c'" });
    }
    const idea = await service.submit(
      wid,
      { problem, targetUser, insight, wedge, marketPath, segment: segment ?? null },
      id.memberId,
    );
    return reply.code(201).send(idea);
  });

  /** #96 steps 2–3 SCORE: gather evidence + dual-persona scoring, persist a scorecard. */
  app.post("/workspaces/:wid/ventures/:vid/score", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, vid } = req.params as { wid: string; vid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    try {
      return reply.send(await service.score(wid, vid));
    } catch (err) {
      if (err instanceof VentureNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  /** #96 step 4 DECIDE: run the pure gate on the latest scorecard + apply the verdict's effects. */
  app.post("/workspaces/:wid/ventures/:vid/decide", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, vid } = req.params as { wid: string; vid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    try {
      return reply.send(await service.decide(wid, vid));
    } catch (err) {
      if (err instanceof VentureNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  /** #96 hardening: advance the evaluation one tick (score+decide as one durable step). Mirrors the
   * scheduled tick + the #71 budget semantics: a budget-exhausted evaluation terminates ESCALATE and
   * the call answers 402 (the same status a session launch gets when the tenant budget is spent). */
  app.post("/workspaces/:wid/ventures/:vid/advance", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, vid } = req.params as { wid: string; vid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    try {
      const result = await service.advance(wid, vid);
      if (result.budgetExhausted) return reply.code(402).send(result);
      return reply.send(result);
    } catch (err) {
      if (err instanceof VentureNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  /** Read a full venture view: the idea, its latest scorecard, and the iteration log. */
  app.get("/workspaces/:wid/ventures/:vid", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, vid } = req.params as { wid: string; vid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    try {
      return reply.send(await service.get(wid, vid));
    } catch (err) {
      if (err instanceof VentureNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });
}
