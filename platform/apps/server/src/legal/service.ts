/**
 * LegalService (#196, ADR-0196) — the IO orchestrator for the per-venture Legal & Compliance pack,
 * modelled on the #114 CustomerVoiceService: side effects here, the pure generate/compliance/precheck/
 * regulated logic in the sibling modules. Every collaborator is an injected seam so the loop is
 * unit-tested over fakes (no DB, no agent spend, no network); `default.ts` wires production.
 *
 * Every outbound action a venture's legal lifecycle produces — publishing a generated ToS/privacy doc,
 * surfacing a naming decision — becomes a **pending #13 `external.send`** (sensitive-by-default): a human
 * owner reviews it in the decision queue. The service NEVER auto-publishes and NEVER auto-clears a gate;
 * `legal.enabled`/`autoRegenerate` only gate the *proactive* regeneration posture (default OFF).
 */
import { composePack, fingerprintFacts, isMaterialChange } from "./generate.js";
import { assessRegulated, decideNamingDisposition } from "./regulated.js";
import { REGULATED_HARD_STOP_NOTICE } from "./disclaimer.js";
import type { LegalCaps } from "./caps.js";
import type {
  ComposedDocument,
  ConsentBasis,
  DataRightsRequest,
  DataRightsType,
  LegalDocument,
  LegalDocumentKind,
  NamingPrecheck,
  NamingPrecheckResult,
  RegulatedAssessment,
  SuppressionSource,
  VentureLegalFacts,
} from "./types.js";

// ───────────────────────────── persistence seams ─────────────────────────────

export interface LegalFactsStore {
  get(workspaceId: string, ventureIdeaId: string): Promise<VentureLegalFacts | undefined>;
  upsert(workspaceId: string, facts: VentureLegalFacts): Promise<VentureLegalFacts>;
}

export interface CreateDocumentInput {
  workspaceId: string;
  ventureIdeaId: string;
  kind: LegalDocumentKind;
  version: string;
  contentHash: string;
  sourceFactsHash: string;
  body: string;
  approvalRequestId: string | null;
}

export interface LegalDocStore {
  /** Idempotent on (workspace, venture, kind, version): re-generating identical facts re-attaches, never dupes. */
  create(input: CreateDocumentInput): Promise<{ document: LegalDocument; deduped: boolean }>;
  listForVenture(workspaceId: string, ventureIdeaId: string): Promise<LegalDocument[]>;
  latestPublished(workspaceId: string, ventureIdeaId: string, kind: LegalDocumentKind): Promise<LegalDocument | undefined>;
}

export interface SuppressionStore {
  isSuppressed(workspaceId: string, contact: string): Promise<boolean>;
  add(input: { workspaceId: string; contact: string; reason: string | null; source: SuppressionSource }): Promise<void>;
  list(workspaceId: string): Promise<{ contact: string; source: SuppressionSource; reason: string | null }[]>;
}

export interface ConsentStore {
  hasConsent(workspaceId: string, contact: string): Promise<boolean>;
  record(input: { workspaceId: string; contact: string; basis: ConsentBasis; ventureIdeaId: string | null; sourceRef: string | null }): Promise<void>;
  listForContact(workspaceId: string, contact: string): Promise<{ basis: ConsentBasis; createdAt: Date }[]>;
}

export interface DataRightsStore {
  create(input: { workspaceId: string; ventureIdeaId: string | null; subjectContact: string; type: DataRightsType; requestedByMemberId: string | null }): Promise<DataRightsRequest>;
  complete(workspaceId: string, id: string, result: Record<string, unknown>): Promise<DataRightsRequest | undefined>;
  list(workspaceId: string): Promise<DataRightsRequest[]>;
}

/** The #13 gate seam: a publish/naming decision becomes a PENDING approval request (sensitive-by-default). */
export interface LegalGate {
  submit(input: {
    workspaceId: string;
    requesterMemberId: string;
    actionType: string;
    payload: Record<string, unknown>;
    amount: number | null;
    summary: string;
  }): Promise<{ id: string }>;
}

/** Tenant-scoped venture-idea ownership lookup (the #19 IDOR boundary). */
export interface VentureLookup {
  exists(workspaceId: string, ventureIdeaId: string): Promise<boolean>;
}

export interface LegalServiceDeps {
  facts: LegalFactsStore;
  documents: LegalDocStore;
  suppressions: SuppressionStore;
  consent: ConsentStore;
  dataRights: DataRightsStore;
  gate: LegalGate;
  precheck: NamingPrecheck;
  ventures: VentureLookup;
  caps: (workspaceId: string) => LegalCaps;
  now?: () => Date;
}

export class LegalNotFoundError extends Error {
  constructor(message = "legal resource not found") {
    super(message);
    this.name = "LegalNotFoundError";
  }
}

export interface GenerateResult {
  documents: LegalDocument[];
  approvalRequestId: string;
  regulated: RegulatedAssessment;
}

export interface NamingDecisionResult {
  precheck: NamingPrecheckResult;
  regulated: RegulatedAssessment;
  disposition: ReturnType<typeof decideNamingDisposition>["disposition"];
  reasons: string[];
  approvalRequestId: string;
}

export class LegalService {
  constructor(private readonly deps: LegalServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async assertVenture(workspaceId: string, ventureIdeaId: string): Promise<void> {
    if (!(await this.deps.ventures.exists(workspaceId, ventureIdeaId))) {
      throw new LegalNotFoundError("venture idea not found in this workspace");
    }
  }

  /** Save (or replace) the legal facts a venture's documents generate from. */
  async saveFacts(workspaceId: string, facts: VentureLegalFacts): Promise<VentureLegalFacts> {
    await this.assertVenture(workspaceId, facts.ventureIdeaId);
    return this.deps.facts.upsert(workspaceId, facts);
  }

  async getFacts(workspaceId: string, ventureIdeaId: string): Promise<VentureLegalFacts | undefined> {
    return this.deps.facts.get(workspaceId, ventureIdeaId);
  }

  /**
   * Generate the ToS + privacy pack from the venture's facts, persist them as drafts, and submit ONE
   * pending #13 publish approval (owner review). Also runs the regulated-industry assessment: a regulated
   * venture's approval summary carries the hard-stop notice (criterion 5). 404 if no facts on file.
   */
  async generate(workspaceId: string, ventureIdeaId: string, requesterMemberId: string): Promise<GenerateResult> {
    await this.assertVenture(workspaceId, ventureIdeaId);
    const facts = await this.deps.facts.get(workspaceId, ventureIdeaId);
    if (!facts) throw new LegalNotFoundError("no legal facts on file for this venture — save facts first");

    const regulated = assessRegulated({ industry: facts.industry, dataCollected: facts.dataCollected });
    const composed = composePack(facts);

    const versions = composed.map((c) => `${c.kind} v${c.version}`).join(", ");
    const summary = regulated.regulated
      ? `Review & publish legal docs (${versions}) — ⚠️ REGULATED (${regulated.category}): ${REGULATED_HARD_STOP_NOTICE}`
      : `Review & publish generated legal docs for venture ${ventureIdeaId}: ${versions}`;

    const approval = await this.deps.gate.submit({
      workspaceId,
      requesterMemberId,
      actionType: "external.send",
      payload: {
        kind: "content.publish",
        summary,
        target: `/legal/${ventureIdeaId}`,
        ventureIdeaId,
        documents: composed.map((c) => ({ kind: c.kind, version: c.version })),
        regulated: regulated.regulated,
        regulatedCategory: regulated.category,
      },
      amount: null,
      summary,
    });

    const documents: LegalDocument[] = [];
    for (const c of composed) {
      const { document } = await this.deps.documents.create({
        workspaceId,
        ventureIdeaId,
        kind: c.kind,
        version: c.version,
        contentHash: c.contentHash,
        sourceFactsHash: c.sourceFactsHash,
        body: c.body,
        approvalRequestId: approval.id,
      });
      documents.push(document);
    }

    return { documents, approvalRequestId: approval.id, regulated };
  }

  /**
   * Detect a material change (the facts that generated the latest published doc no longer fingerprint the
   * same) and, when the workspace opted into `autoRegenerate`, regenerate + open a fresh owner-review
   * approval. Returns `{ changed:false }` when nothing drifted or auto-regen is off (the safe default).
   */
  async regenerateIfChanged(
    workspaceId: string,
    ventureIdeaId: string,
    requesterMemberId: string,
  ): Promise<{ changed: boolean; result?: GenerateResult }> {
    await this.assertVenture(workspaceId, ventureIdeaId);
    const facts = await this.deps.facts.get(workspaceId, ventureIdeaId);
    if (!facts) return { changed: false };

    const latest = await this.deps.documents.latestPublished(workspaceId, ventureIdeaId, "privacy");
    // No published baseline yet ⇒ nothing to "re-generate on change" against.
    if (!latest) return { changed: false };
    if (!isMaterialChange(latest.sourceFactsHash, facts)) return { changed: false };
    if (!this.deps.caps(workspaceId).autoRegenerate) return { changed: false };

    const result = await this.generate(workspaceId, ventureIdeaId, requesterMemberId);
    return { changed: true, result };
  }

  async listDocuments(workspaceId: string, ventureIdeaId: string): Promise<LegalDocument[]> {
    await this.assertVenture(workspaceId, ventureIdeaId);
    return this.deps.documents.listForVenture(workspaceId, ventureIdeaId);
  }

  /**
   * Run the name/trademark + domain-collision pre-check (criterion 3) plus the regulated-industry
   * assessment, and attach the combined verdict to a pending #13 naming-decision approval. The unbuilt
   * #187 venture factory calls this at its naming step *before purchase*; a `hard_stop` disposition means
   * the approval can never auto-clear (owner + counsel).
   */
  async runNamingPrecheck(input: {
    workspaceId: string;
    requesterMemberId: string;
    name: string;
    domains: string[];
    industry?: string | null;
    dataCollected?: string[];
  }): Promise<NamingDecisionResult> {
    const precheck = await this.deps.precheck.check({ name: input.name, domains: input.domains });
    const regulated = assessRegulated({ industry: input.industry ?? null, dataCollected: input.dataCollected ?? [] });
    const { disposition, reasons } = decideNamingDisposition(precheck, regulated);

    const summary =
      disposition === "hard_stop"
        ? `Naming decision for “${input.name}” — ⚠️ HARD STOP (regulated: ${regulated.category}). ${REGULATED_HARD_STOP_NOTICE}`
        : `Naming decision for “${input.name}” — ${disposition} (trademark ${precheck.trademarkRisk})`;

    const approval = await this.deps.gate.submit({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      actionType: "external.send",
      payload: {
        kind: "naming.decision",
        summary,
        name: input.name,
        precheck,
        regulated,
        disposition,
        reasons,
      },
      amount: null,
      summary,
    });

    return { precheck, regulated, disposition, reasons, approvalRequestId: approval.id };
  }

  // ───────────────────────────── consent / suppression ─────────────────────────────

  async suppress(workspaceId: string, contact: string, source: SuppressionSource, reason: string | null): Promise<void> {
    await this.deps.suppressions.add({ workspaceId, contact: contact.trim().toLowerCase(), reason, source });
  }

  async recordConsent(input: {
    workspaceId: string;
    contact: string;
    basis: ConsentBasis;
    ventureIdeaId?: string | null;
    sourceRef?: string | null;
  }): Promise<void> {
    await this.deps.consent.record({
      workspaceId: input.workspaceId,
      contact: input.contact.trim().toLowerCase(),
      basis: input.basis,
      ventureIdeaId: input.ventureIdeaId ?? null,
      sourceRef: input.sourceRef ?? null,
    });
  }

  // ───────────────────────────── data rights (criterion 4) ─────────────────────────────

  /**
   * Honor a data-subject EXPORT request end-to-end: record the request, gather everything the platform
   * holds for the contact (consent records + suppression state + prior requests), and mark it completed
   * with that bundle as the audited result.
   */
  async requestDataExport(input: {
    workspaceId: string;
    subjectContact: string;
    requestedByMemberId: string | null;
    ventureIdeaId?: string | null;
  }): Promise<DataRightsRequest> {
    const contact = input.subjectContact.trim().toLowerCase();
    const req = await this.deps.dataRights.create({
      workspaceId: input.workspaceId,
      ventureIdeaId: input.ventureIdeaId ?? null,
      subjectContact: contact,
      type: "export",
      requestedByMemberId: input.requestedByMemberId,
    });
    const consent = await this.deps.consent.listForContact(input.workspaceId, contact);
    const suppressed = await this.deps.suppressions.isSuppressed(input.workspaceId, contact);
    const result = {
      contact,
      exportedAt: this.now().toISOString(),
      consentRecords: consent,
      suppressed,
    };
    return (await this.deps.dataRights.complete(input.workspaceId, req.id, result)) ?? req;
  }

  /**
   * Honor a data-subject DELETION request end-to-end: record the request, add the contact to the
   * suppression list (so no future commercial send can reach them — enforced in code at the chokepoint),
   * and mark it completed. The suppression is the durable, audited proof the opt-out is honored.
   */
  async requestDataDeletion(input: {
    workspaceId: string;
    subjectContact: string;
    requestedByMemberId: string | null;
    ventureIdeaId?: string | null;
  }): Promise<DataRightsRequest> {
    const contact = input.subjectContact.trim().toLowerCase();
    const req = await this.deps.dataRights.create({
      workspaceId: input.workspaceId,
      ventureIdeaId: input.ventureIdeaId ?? null,
      subjectContact: contact,
      type: "deletion",
      requestedByMemberId: input.requestedByMemberId,
    });
    await this.deps.suppressions.add({
      workspaceId: input.workspaceId,
      contact,
      reason: `data deletion request ${req.id}`,
      source: "deletion_request",
    });
    const result = { contact, deletedAt: this.now().toISOString(), suppressed: true };
    return (await this.deps.dataRights.complete(input.workspaceId, req.id, result)) ?? req;
  }

  async listDataRights(workspaceId: string): Promise<DataRightsRequest[]> {
    return this.deps.dataRights.list(workspaceId);
  }

  // facts fingerprint is exposed for callers that want to detect drift without regenerating.
  factsFingerprint(facts: VentureLegalFacts): string {
    return fingerprintFacts(facts);
  }

  // ComposedDocument re-export hook for callers that only want a preview (no persistence).
  preview(facts: VentureLegalFacts): ComposedDocument[] {
    return composePack(facts);
  }
}
