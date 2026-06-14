import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import {
  complianceEvents,
  consentRecords,
  dataRightsRequests,
  emailSuppressions,
  legalDocuments,
  ventureLegalFacts,
} from "../schema/index.js";
import type {
  ConsentStore,
  CreateDocumentInput,
  DataRightsStore,
  LegalDocStore,
  LegalFactsStore,
  SuppressionStore,
} from "../../legal/service.js";
import type {
  ConsentBasis,
  DataRightsRequest,
  DataRightsType,
  LegalDocument,
  LegalDocumentKind,
  SuppressionSource,
} from "../../legal/types.js";

/**
 * Legal & Compliance pack repository (#196, ADR-0196). Workspace-scoped throughout (the #3 IDOR
 * discipline); the pure generate/compliance/precheck logic lives in `../../legal/*` — this is persistence
 * only. Implements the store seams the {@link LegalService} injects, plus the suppression/consent readers
 * the {@link defaultComplianceEnforcer} consults at the send chokepoint.
 */

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

function rowToDocument(row: typeof legalDocuments.$inferSelect): LegalDocument {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ventureIdeaId: row.ventureIdeaId,
    kind: row.kind as LegalDocumentKind,
    version: row.version,
    contentHash: row.contentHash,
    sourceFactsHash: row.sourceFactsHash,
    body: row.body,
    status: row.status as LegalDocument["status"],
    approvalRequestId: row.approvalRequestId,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
  };
}

function rowToDataRights(row: typeof dataRightsRequests.$inferSelect): DataRightsRequest {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ventureIdeaId: row.ventureIdeaId,
    subjectContact: row.subjectContact,
    type: row.type as DataRightsType,
    status: row.status as DataRightsRequest["status"],
    requestedByMemberId: row.requestedByMemberId,
    result: (row.result as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

export const dbLegalFactsStore: LegalFactsStore = {
  async get(workspaceId, ventureIdeaId) {
    const [row] = await db
      .select()
      .from(ventureLegalFacts)
      .where(and(eq(ventureLegalFacts.workspaceId, workspaceId), eq(ventureLegalFacts.ventureIdeaId, ventureIdeaId)))
      .limit(1);
    if (!row) return undefined;
    return {
      ventureIdeaId: row.ventureIdeaId,
      jurisdiction: row.jurisdiction,
      dataCollected: toStringArray(row.dataCollected),
      paymentFlows: toStringArray(row.paymentFlows),
      industry: row.industry,
    };
  },
  async upsert(workspaceId, facts) {
    const [row] = await db
      .insert(ventureLegalFacts)
      .values({
        workspaceId,
        ventureIdeaId: facts.ventureIdeaId,
        jurisdiction: facts.jurisdiction,
        dataCollected: facts.dataCollected,
        paymentFlows: facts.paymentFlows,
        industry: facts.industry,
      })
      .onConflictDoUpdate({
        target: [ventureLegalFacts.workspaceId, ventureLegalFacts.ventureIdeaId],
        set: {
          jurisdiction: facts.jurisdiction,
          dataCollected: facts.dataCollected,
          paymentFlows: facts.paymentFlows,
          industry: facts.industry,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error("venture_legal_facts upsert returned no row");
    return {
      ventureIdeaId: row.ventureIdeaId,
      jurisdiction: row.jurisdiction,
      dataCollected: toStringArray(row.dataCollected),
      paymentFlows: toStringArray(row.paymentFlows),
      industry: row.industry,
    };
  },
};

export const dbLegalDocStore: LegalDocStore = {
  async create(input: CreateDocumentInput) {
    const [row] = await db
      .insert(legalDocuments)
      .values({
        workspaceId: input.workspaceId,
        ventureIdeaId: input.ventureIdeaId,
        kind: input.kind,
        version: input.version,
        contentHash: input.contentHash,
        sourceFactsHash: input.sourceFactsHash,
        body: input.body,
        approvalRequestId: input.approvalRequestId,
      })
      .onConflictDoNothing({
        target: [legalDocuments.workspaceId, legalDocuments.ventureIdeaId, legalDocuments.kind, legalDocuments.version],
      })
      .returning();
    if (row) return { document: rowToDocument(row), deduped: false };
    // Conflict: the (venture, kind, version) already exists — fetch it (idempotent re-generation).
    const [existing] = await db
      .select()
      .from(legalDocuments)
      .where(
        and(
          eq(legalDocuments.workspaceId, input.workspaceId),
          eq(legalDocuments.ventureIdeaId, input.ventureIdeaId),
          eq(legalDocuments.kind, input.kind),
          eq(legalDocuments.version, input.version),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("legal_documents conflict but row not found");
    return { document: rowToDocument(existing), deduped: true };
  },
  async listForVenture(workspaceId, ventureIdeaId) {
    const rows = await db
      .select()
      .from(legalDocuments)
      .where(and(eq(legalDocuments.workspaceId, workspaceId), eq(legalDocuments.ventureIdeaId, ventureIdeaId)))
      .orderBy(desc(legalDocuments.createdAt));
    return rows.map(rowToDocument);
  },
  async latestPublished(workspaceId, ventureIdeaId, kind) {
    const [row] = await db
      .select()
      .from(legalDocuments)
      .where(
        and(
          eq(legalDocuments.workspaceId, workspaceId),
          eq(legalDocuments.ventureIdeaId, ventureIdeaId),
          eq(legalDocuments.kind, kind),
          eq(legalDocuments.status, "published"),
        ),
      )
      .orderBy(desc(legalDocuments.publishedAt))
      .limit(1);
    return row ? rowToDocument(row) : undefined;
  },
};

export const dbSuppressionStore: SuppressionStore = {
  async isSuppressed(workspaceId, contact) {
    const [row] = await db
      .select({ id: emailSuppressions.id })
      .from(emailSuppressions)
      .where(and(eq(emailSuppressions.workspaceId, workspaceId), eq(emailSuppressions.contact, contact.trim().toLowerCase())))
      .limit(1);
    return row !== undefined;
  },
  async add(input) {
    await db
      .insert(emailSuppressions)
      .values({
        workspaceId: input.workspaceId,
        contact: input.contact.trim().toLowerCase(),
        reason: input.reason,
        source: input.source,
      })
      .onConflictDoNothing({ target: [emailSuppressions.workspaceId, emailSuppressions.contact] });
  },
  async list(workspaceId) {
    const rows = await db
      .select()
      .from(emailSuppressions)
      .where(eq(emailSuppressions.workspaceId, workspaceId))
      .orderBy(desc(emailSuppressions.createdAt));
    return rows.map((r) => ({ contact: r.contact, source: r.source as SuppressionSource, reason: r.reason }));
  },
};

export const dbConsentStore: ConsentStore = {
  async hasConsent(workspaceId, contact) {
    const [row] = await db
      .select({ id: consentRecords.id })
      .from(consentRecords)
      .where(and(eq(consentRecords.workspaceId, workspaceId), eq(consentRecords.contact, contact.trim().toLowerCase())))
      .limit(1);
    return row !== undefined;
  },
  async record(input) {
    await db
      .insert(consentRecords)
      .values({
        workspaceId: input.workspaceId,
        contact: input.contact.trim().toLowerCase(),
        basis: input.basis,
        ventureIdeaId: input.ventureIdeaId,
        sourceRef: input.sourceRef,
      })
      .onConflictDoNothing({ target: [consentRecords.workspaceId, consentRecords.contact, consentRecords.basis] });
  },
  async listForContact(workspaceId, contact) {
    const rows = await db
      .select()
      .from(consentRecords)
      .where(and(eq(consentRecords.workspaceId, workspaceId), eq(consentRecords.contact, contact.trim().toLowerCase())))
      .orderBy(desc(consentRecords.createdAt));
    return rows.map((r) => ({ basis: r.basis as ConsentBasis, createdAt: r.createdAt }));
  },
};

export const dbDataRightsStore: DataRightsStore = {
  async create(input) {
    const [row] = await db
      .insert(dataRightsRequests)
      .values({
        workspaceId: input.workspaceId,
        ventureIdeaId: input.ventureIdeaId,
        subjectContact: input.subjectContact,
        type: input.type,
        requestedByMemberId: input.requestedByMemberId,
      })
      .returning();
    if (!row) throw new Error("data_rights_requests insert returned no row");
    return rowToDataRights(row);
  },
  async complete(workspaceId, id, result) {
    const [row] = await db
      .update(dataRightsRequests)
      .set({ status: "completed", result, completedAt: new Date() })
      .where(and(eq(dataRightsRequests.workspaceId, workspaceId), eq(dataRightsRequests.id, id)))
      .returning();
    return row ? rowToDataRights(row) : undefined;
  },
  async list(workspaceId) {
    const rows = await db
      .select()
      .from(dataRightsRequests)
      .where(eq(dataRightsRequests.workspaceId, workspaceId))
      .orderBy(desc(dataRightsRequests.createdAt));
    return rows.map(rowToDataRights);
  },
};

/** Record a send-layer compliance decision to the append-only audit (used by the enforcer). */
export async function recordComplianceEvent(input: {
  workspaceId: string;
  kind: string;
  target: string | null;
  decision: "allow" | "block";
  reason: string | null;
  rules: string[];
  actorMemberId: string | null;
}): Promise<void> {
  await db.insert(complianceEvents).values({
    workspaceId: input.workspaceId,
    kind: input.kind,
    target: input.target,
    decision: input.decision,
    reason: input.reason,
    rules: input.rules,
    actorMemberId: input.actorMemberId,
  });
}
