import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { LegalService, LegalNotFoundError } from "../legal/service.js";
import { CONSENT_BASES, DATA_RIGHTS_TYPES, SUPPRESSION_SOURCES, type ConsentBasis, type DataRightsType, type SuppressionSource } from "../legal/types.js";

/**
 * Legal & Compliance pack routes (#196, ADR-0196). Every route is `requireIdentity` + `assertWorkspace`
 * guarded (the #3 tenant boundary). The venture-scoped routes manage per-venture legal facts + generated
 * ToS/privacy documents (publishing each goes through a pending #13 approval the owner reviews); the
 * workspace-scoped routes run the naming pre-check, manage the suppression/consent rails, and honor data
 * export/deletion requests end-to-end. Nothing here sends or publishes autonomously.
 */
export interface LegalRoutesOptions {
  service: LegalService;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").map((s) => s.trim()).filter(Boolean);
}

export async function legalRoutes(app: FastifyInstance, opts: LegalRoutesOptions): Promise<void> {
  const { service } = opts;

  /** Save (replace) the legal facts a venture's ToS/privacy generate from. */
  app.put("/workspaces/:wid/ventures/:vid/legal/facts", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, vid } = req.params as { wid: string; vid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!UUID_RE.test(vid)) return reply.code(400).send({ error: "ventureId must be a UUID" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const jurisdiction = typeof body.jurisdiction === "string" ? body.jurisdiction.trim() : "";
    if (!jurisdiction) return reply.code(400).send({ error: "jurisdiction is required" });
    try {
      const facts = await service.saveFacts(wid, {
        ventureIdeaId: vid,
        jurisdiction,
        dataCollected: toStringArray(body.dataCollected),
        paymentFlows: toStringArray(body.paymentFlows),
        industry: typeof body.industry === "string" ? body.industry.trim() : null,
      });
      return reply.code(200).send(facts);
    } catch (err) {
      if (err instanceof LegalNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  app.get("/workspaces/:wid/ventures/:vid/legal/facts", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, vid } = req.params as { wid: string; vid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const facts = await service.getFacts(wid, vid);
    if (!facts) return reply.code(404).send({ error: "no legal facts on file for this venture" });
    return reply.send(facts);
  });

  /** Generate the ToS+privacy pack from the venture's facts → persist drafts + open a pending #13 publish
   * approval (owner review). 404 if no facts on file. */
  app.post("/workspaces/:wid/ventures/:vid/legal/generate", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, vid } = req.params as { wid: string; vid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!UUID_RE.test(vid)) return reply.code(400).send({ error: "ventureId must be a UUID" });
    try {
      const result = await service.generate(wid, vid, id.memberId);
      return reply.code(202).send({
        approvalRequestId: result.approvalRequestId,
        regulated: result.regulated,
        documents: result.documents.map((d) => ({ id: d.id, kind: d.kind, version: d.version, status: d.status })),
      });
    } catch (err) {
      if (err instanceof LegalNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  app.get("/workspaces/:wid/ventures/:vid/legal/documents", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, vid } = req.params as { wid: string; vid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    try {
      return reply.send(await service.listDocuments(wid, vid));
    } catch (err) {
      if (err instanceof LegalNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  /** Name/trademark + domain-collision pre-check (criterion 3). The (unbuilt #187) factory calls this at
   * its naming step; the verdict is attached to a pending naming-decision approval. */
  app.post("/workspaces/:wid/legal/naming-precheck", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return reply.code(400).send({ error: "name is required" });
    const result = await service.runNamingPrecheck({
      workspaceId: wid,
      requesterMemberId: id.memberId,
      name,
      domains: toStringArray(body.domains),
      industry: typeof body.industry === "string" ? body.industry : null,
      dataCollected: toStringArray(body.dataCollected),
    });
    return reply.code(202).send(result);
  });

  /** Add a contact to the suppression list (honored in code at the send chokepoint). */
  app.post("/workspaces/:wid/legal/suppressions", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const contact = typeof body.contact === "string" ? body.contact.trim() : "";
    if (!contact) return reply.code(400).send({ error: "contact is required" });
    const source = (SUPPRESSION_SOURCES as readonly string[]).includes(String(body.source))
      ? (body.source as SuppressionSource)
      : "manual";
    await service.suppress(wid, contact, source, typeof body.reason === "string" ? body.reason : null);
    return reply.code(201).send({ contact: contact.toLowerCase(), source });
  });

  /** Record a consent basis for a contact (CASL/GDPR lawful basis to email). */
  app.post("/workspaces/:wid/legal/consent", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const contact = typeof body.contact === "string" ? body.contact.trim() : "";
    if (!contact) return reply.code(400).send({ error: "contact is required" });
    if (!(CONSENT_BASES as readonly string[]).includes(String(body.basis))) {
      return reply.code(400).send({ error: `basis must be one of ${CONSENT_BASES.join(" | ")}` });
    }
    await service.recordConsent({
      workspaceId: wid,
      contact,
      basis: body.basis as ConsentBasis,
      ventureIdeaId: typeof body.ventureIdeaId === "string" ? body.ventureIdeaId : null,
      sourceRef: typeof body.sourceRef === "string" ? body.sourceRef : null,
    });
    return reply.code(201).send({ contact: contact.toLowerCase(), basis: body.basis });
  });

  /** Honor a data-subject export/deletion request end-to-end (criterion 4), audited. */
  app.post("/workspaces/:wid/legal/data-requests", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectContact = typeof body.subjectContact === "string" ? body.subjectContact.trim() : "";
    if (!subjectContact) return reply.code(400).send({ error: "subjectContact is required" });
    if (!(DATA_RIGHTS_TYPES as readonly string[]).includes(String(body.type))) {
      return reply.code(400).send({ error: `type must be one of ${DATA_RIGHTS_TYPES.join(" | ")}` });
    }
    const type = body.type as DataRightsType;
    const ventureIdeaId = typeof body.ventureIdeaId === "string" ? body.ventureIdeaId : null;
    const result =
      type === "export"
        ? await service.requestDataExport({ workspaceId: wid, subjectContact, requestedByMemberId: id.memberId, ventureIdeaId })
        : await service.requestDataDeletion({ workspaceId: wid, subjectContact, requestedByMemberId: id.memberId, ventureIdeaId });
    return reply.code(202).send(result);
  });

  app.get("/workspaces/:wid/legal/data-requests", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return reply.send(await service.listDataRights(wid));
  });
}
