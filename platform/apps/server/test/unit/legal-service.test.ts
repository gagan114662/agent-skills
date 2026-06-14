import { describe, it, expect } from "vitest";
import { LegalService, LegalNotFoundError } from "../../src/legal/service.js";
import type {
  ConsentStore,
  CreateDocumentInput,
  DataRightsStore,
  LegalDocStore,
  LegalFactsStore,
  LegalGate,
  SuppressionStore,
  VentureLookup,
} from "../../src/legal/service.js";
import { LEGAL_DEFAULTS, type LegalCaps } from "../../src/legal/caps.js";
import { deterministicNamingPrecheck } from "../../src/legal/precheck.js";
import type { DataRightsRequest, LegalDocument, VentureLegalFacts } from "../../src/legal/types.js";

const VENTURE = "11111111-1111-1111-1111-111111111111";
const MEMBER = "22222222-2222-2222-2222-222222222222";

function fakeFactsStore(seed?: VentureLegalFacts): LegalFactsStore {
  let stored = seed;
  return {
    get: (_w, vid) => Promise.resolve(stored && stored.ventureIdeaId === vid ? stored : undefined),
    upsert: (_w, facts) => {
      stored = facts;
      return Promise.resolve(facts);
    },
  };
}

function fakeDocStore(): LegalDocStore & { rows: LegalDocument[] } {
  const rows: LegalDocument[] = [];
  return {
    rows,
    create: (input: CreateDocumentInput) => {
      const existing = rows.find(
        (r) => r.ventureIdeaId === input.ventureIdeaId && r.kind === input.kind && r.version === input.version,
      );
      if (existing) return Promise.resolve({ document: existing, deduped: true });
      const doc: LegalDocument = {
        id: `doc-${rows.length + 1}`,
        workspaceId: input.workspaceId,
        ventureIdeaId: input.ventureIdeaId,
        kind: input.kind,
        version: input.version,
        contentHash: input.contentHash,
        sourceFactsHash: input.sourceFactsHash,
        body: input.body,
        status: "draft",
        approvalRequestId: input.approvalRequestId,
        publishedAt: null,
        createdAt: new Date(0),
      };
      rows.push(doc);
      return Promise.resolve({ document: doc, deduped: false });
    },
    listForVenture: (_w, vid) => Promise.resolve(rows.filter((r) => r.ventureIdeaId === vid)),
    latestPublished: (_w, vid, kind) =>
      Promise.resolve(rows.filter((r) => r.ventureIdeaId === vid && r.kind === kind && r.status === "published").at(-1)),
  };
}

function fakeSuppressionStore(): SuppressionStore & { suppressed: Set<string> } {
  const suppressed = new Set<string>();
  return {
    suppressed,
    isSuppressed: (_w, c) => Promise.resolve(suppressed.has(c.toLowerCase())),
    add: (input) => {
      suppressed.add(input.contact.toLowerCase());
      return Promise.resolve();
    },
    list: () => Promise.resolve([...suppressed].map((contact) => ({ contact, source: "manual" as const, reason: null }))),
  };
}

function fakeConsentStore(): ConsentStore & { records: { contact: string; basis: string }[] } {
  const records: { contact: string; basis: string }[] = [];
  return {
    records,
    hasConsent: (_w, c) => Promise.resolve(records.some((r) => r.contact === c.toLowerCase())),
    record: (input) => {
      records.push({ contact: input.contact.toLowerCase(), basis: input.basis });
      return Promise.resolve();
    },
    listForContact: (_w, c) =>
      Promise.resolve(records.filter((r) => r.contact === c.toLowerCase()).map((r) => ({ basis: r.basis as never, createdAt: new Date(0) }))),
  };
}

function fakeDataRightsStore(): DataRightsStore & { rows: DataRightsRequest[] } {
  const rows: DataRightsRequest[] = [];
  return {
    rows,
    create: (input) => {
      const row: DataRightsRequest = {
        id: `dr-${rows.length + 1}`,
        workspaceId: input.workspaceId,
        ventureIdeaId: input.ventureIdeaId,
        subjectContact: input.subjectContact,
        type: input.type,
        status: "received",
        requestedByMemberId: input.requestedByMemberId,
        result: null,
        createdAt: new Date(0),
        completedAt: null,
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    complete: (_w, id, result) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return Promise.resolve(undefined);
      row.status = "completed";
      row.result = result;
      row.completedAt = new Date(0);
      return Promise.resolve(row);
    },
    list: () => Promise.resolve(rows),
  };
}

function fakeGate(): LegalGate & { calls: { summary: string; payload: Record<string, unknown> }[] } {
  const calls: { summary: string; payload: Record<string, unknown> }[] = [];
  return {
    calls,
    submit: (input) => {
      calls.push({ summary: input.summary, payload: input.payload });
      return Promise.resolve({ id: `appr-${calls.length}` });
    },
  };
}

const ventures: VentureLookup = { exists: (_w, vid) => Promise.resolve(vid === VENTURE) };

const baseFacts: VentureLegalFacts = {
  ventureIdeaId: VENTURE,
  jurisdiction: "US-CA",
  dataCollected: ["email", "payment"],
  paymentFlows: ["stripe_subscription"],
  industry: "saas",
};

function build(opts?: { facts?: VentureLegalFacts; caps?: Partial<LegalCaps> }) {
  const facts = fakeFactsStore(opts?.facts);
  const documents = fakeDocStore();
  const suppressions = fakeSuppressionStore();
  const consent = fakeConsentStore();
  const dataRights = fakeDataRightsStore();
  const gate = fakeGate();
  const caps: LegalCaps = { ...LEGAL_DEFAULTS, ...opts?.caps };
  const service = new LegalService({
    facts,
    documents,
    suppressions,
    consent,
    dataRights,
    gate,
    precheck: deterministicNamingPrecheck,
    ventures,
    caps: () => caps,
    now: () => new Date(0),
  });
  return { service, facts, documents, suppressions, consent, dataRights, gate };
}

describe("LegalService — documents (#196 criterion 1)", () => {
  it("generates a ToS+privacy pack and opens ONE pending #13 publish approval", async () => {
    const { service, documents, gate } = build({ facts: baseFacts });
    const result = await service.generate("ws", VENTURE, MEMBER);
    expect(result.documents.map((d) => d.kind).sort()).toEqual(["privacy", "tos"]);
    expect(documents.rows).toHaveLength(2);
    expect(gate.calls).toHaveLength(1); // one owner-review approval for the publish
    expect(gate.calls[0].payload.kind).toBe("content.publish");
    expect(result.documents.every((d) => d.approvalRequestId === "appr-1")).toBe(true);
  });

  it("404s when generating with no facts on file", async () => {
    const { service } = build();
    await expect(service.generate("ws", VENTURE, MEMBER)).rejects.toBeInstanceOf(LegalNotFoundError);
  });

  it("404s for a venture outside the workspace (IDOR boundary)", async () => {
    const { service } = build({ facts: baseFacts });
    await expect(service.generate("ws", "99999999-9999-9999-9999-999999999999", MEMBER)).rejects.toBeInstanceOf(
      LegalNotFoundError,
    );
  });

  it("regenerateIfChanged is a no-op without a published baseline", async () => {
    const { service } = build({ facts: baseFacts });
    expect((await service.regenerateIfChanged("ws", VENTURE, MEMBER)).changed).toBe(false);
  });

  it("regenerates on a material change only when autoRegenerate is on", async () => {
    const { service, documents } = build({ facts: baseFacts, caps: { autoRegenerate: true } });
    // Seed a published privacy doc whose source facts differ from current → material change.
    documents.rows.push({
      id: "pub-1",
      workspaceId: "ws",
      ventureIdeaId: VENTURE,
      kind: "privacy",
      version: "oldversion000",
      contentHash: "oldversion000",
      sourceFactsHash: "stale-hash",
      body: "old",
      status: "published",
      approvalRequestId: null,
      publishedAt: new Date(0),
      createdAt: new Date(0),
    });
    const res = await service.regenerateIfChanged("ws", VENTURE, MEMBER);
    expect(res.changed).toBe(true);
    expect(res.result?.approvalRequestId).toBeDefined();
  });

  it("does NOT regenerate on a material change when autoRegenerate is off (safe default)", async () => {
    const { service, documents } = build({ facts: baseFacts, caps: { autoRegenerate: false } });
    documents.rows.push({
      id: "pub-1", workspaceId: "ws", ventureIdeaId: VENTURE, kind: "privacy", version: "v0",
      contentHash: "v0", sourceFactsHash: "stale", body: "old", status: "published",
      approvalRequestId: null, publishedAt: new Date(0), createdAt: new Date(0),
    });
    expect((await service.regenerateIfChanged("ws", VENTURE, MEMBER)).changed).toBe(false);
  });
});

describe("LegalService — naming pre-check (#196 criterion 3 + 5)", () => {
  it("attaches a clean low-risk verdict to a pending naming-decision approval", async () => {
    const { service, gate } = build();
    const res = await service.runNamingPrecheck({
      workspaceId: "ws",
      requesterMemberId: MEMBER,
      name: "Quibbleflux",
      domains: ["quibbleflux.com", "quibbleflux.app"], // .app is deterministically available
      industry: "saas",
    });
    expect(res.disposition).toBe("proceed");
    expect(gate.calls).toHaveLength(1);
    expect(gate.calls[0].payload.kind).toBe("naming.decision");
  });

  it("hard-stops a regulated venture (high-risk) to the owner", async () => {
    const { service, gate } = build();
    const res = await service.runNamingPrecheck({
      workspaceId: "ws",
      requesterMemberId: MEMBER,
      name: "Quibbleflux",
      domains: ["quibbleflux.com"],
      industry: "telehealth",
    });
    expect(res.disposition).toBe("hard_stop");
    expect(gate.calls[0].summary).toMatch(/HARD STOP/);
  });
});

describe("LegalService — data rights (#196 criterion 4)", () => {
  it("honors an export request end-to-end and marks it completed with the data bundle", async () => {
    const { service, consent } = build();
    await consent.record({ workspaceId: "ws", contact: "user@x.com", basis: "opt_in", ventureIdeaId: null, sourceRef: null });
    const req = await service.requestDataExport({ workspaceId: "ws", subjectContact: "User@X.com", requestedByMemberId: MEMBER });
    expect(req.status).toBe("completed");
    expect((req.result as { consentRecords: unknown[] }).consentRecords).toHaveLength(1);
  });

  it("honors a deletion request by suppressing the contact (enforced at the send chokepoint)", async () => {
    const { service, suppressions } = build();
    const req = await service.requestDataDeletion({ workspaceId: "ws", subjectContact: "Gone@X.com", requestedByMemberId: MEMBER });
    expect(req.status).toBe("completed");
    expect(suppressions.suppressed.has("gone@x.com")).toBe(true);
  });
});
