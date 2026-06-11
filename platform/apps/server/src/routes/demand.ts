import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import {
  DemandValidationService,
  DemandNotFoundError,
  DemandStateError,
  EthicsDisclosureError,
  type Availability,
} from "../demand/service.js";
import { ExperimentSpecError, type ExperimentSpec } from "../demand/experiment.js";
import { DEMAND_SIGNAL_CLASSES, type DemandSignalClass } from "../demand/provenance.js";

/**
 * Demand Validation Rails routes (#101): register / launch / capture-signal / view under
 * `/workspaces/:wid/ventures/:vid/experiments`. Thin adapters over {@link DemandValidationService} —
 * identity + the #19 `assertWorkspace` IDOR boundary, then a single service call. The apex `paid` signal
 * never has a route — it arrives only through the #98 signature-verified webhook (a stranger's money is
 * attributed by Stripe, not by us).
 */
export interface DemandRoutesOptions {
  service: DemandValidationService;
}

const AVAILABILITIES: readonly Availability[] = ["available", "waitlist", "preorder"];
/** Funnel classes a public client may post (everything but `paid`, which is webhook-only). */
const PUBLIC_SIGNAL_CLASSES: readonly DemandSignalClass[] = DEMAND_SIGNAL_CLASSES.filter(
  (c) => c !== "paid",
);

export async function demandRoutes(app: FastifyInstance, opts: DemandRoutesOptions): Promise<void> {
  const { service } = opts;

  /** Register a LOCKED experiment for a venture idea (the bar is fixed before launch — anti-p-hacking). */
  app.post("/workspaces/:wid/ventures/:vid/experiments", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, vid } = req.params as { wid: string; vid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const spec: ExperimentSpec = {
      hypothesis: String(body.hypothesis ?? ""),
      successClass: body.successClass as DemandSignalClass,
      denominatorClass: body.denominatorClass as DemandSignalClass,
      passThreshold: Number(body.passThreshold),
      minSample: Number(body.minSample),
      windowStartMs: Number(body.windowStartMs),
      windowEndMs: Number(body.windowEndMs),
    };
    const availability = body.availability as Availability;
    if (!AVAILABILITIES.includes(availability)) {
      return reply.code(400).send({ error: "availability must be available | waitlist | preorder" });
    }
    if (!DEMAND_SIGNAL_CLASSES.includes(spec.successClass) || !DEMAND_SIGNAL_CLASSES.includes(spec.denominatorClass)) {
      return reply.code(400).send({ error: "successClass/denominatorClass must be valid funnel classes" });
    }
    try {
      const exp = await service.register({
        workspaceId: wid,
        ventureIdeaId: vid,
        spec,
        availability,
        disclosure: typeof body.disclosure === "string" ? body.disclosure : null,
        createdByMemberId: id.memberId,
      });
      return reply.code(201).send(exp);
    } catch (err) {
      if (err instanceof ExperimentSpecError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  /** List a venture idea's experiments. */
  app.get("/workspaces/:wid/ventures/:vid/experiments", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, vid } = req.params as { wid: string; vid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return reply.send(await service.list(wid, vid));
  });

  /** Launch the fake-door (deploy landing + mint checkout). Ethics-gated (409) on a missing disclosure. */
  app.post("/workspaces/:wid/ventures/:vid/experiments/:eid/launch", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, eid } = req.params as { wid: string; eid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    try {
      return reply.send(await service.launch(wid, eid));
    } catch (err) {
      if (err instanceof DemandNotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof EthicsDisclosureError) return reply.code(409).send({ error: err.message });
      if (err instanceof DemandStateError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  /** Capture a funnel signal (visit / cta_click / checkout_started / waitlist) from the landing page. */
  app.post("/workspaces/:wid/ventures/:vid/experiments/:eid/signals", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, eid } = req.params as { wid: string; eid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const signalClass = body.signalClass as DemandSignalClass;
    const externalRef = typeof body.externalRef === "string" ? body.externalRef.trim() : "";
    if (!PUBLIC_SIGNAL_CLASSES.includes(signalClass)) {
      return reply
        .code(400)
        .send({ error: `signalClass must be one of ${PUBLIC_SIGNAL_CLASSES.join(", ")} (paid is webhook-only)` });
    }
    if (!externalRef) {
      return reply.code(400).send({ error: "externalRef is required (the attribution from outside the building)" });
    }
    try {
      const result = await service.recordSignal(wid, eid, signalClass as Exclude<DemandSignalClass, "paid">, externalRef, {
        amountCents: typeof body.amountCents === "number" ? body.amountCents : 0,
        currency: typeof body.currency === "string" ? body.currency : "usd",
      });
      return reply.code(result.deduped ? 200 : 201).send(result);
    } catch (err) {
      if (err instanceof DemandNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  /** The experiment view: the spec + the funnel + the verdict against the LOCKED bar. */
  app.get("/workspaces/:wid/ventures/:vid/experiments/:eid", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, eid } = req.params as { wid: string; eid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    try {
      return reply.send(await service.view(wid, eid));
    } catch (err) {
      if (err instanceof DemandNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });
}
