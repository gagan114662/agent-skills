import { describe, it, expect } from "vitest";
import { OnboardingService, type OnboardingDeps } from "../../src/onboarding/service.js";
import { DryRunDnsProvider } from "../../src/onboarding/dns/dry-run-provider.js";
import { ONBOARDING_DEFAULTS } from "../../src/onboarding/caps.js";
import type { RequiredService } from "../../src/onboarding/types.js";
import type { SetupRequestRow } from "../../src/db/repositories/setup-requests.js";
import type { ServiceCredentialRow } from "../../src/db/repositories/external-credentials.js";
import type { DnsReceiptRow } from "../../src/db/repositories/dns-receipts.js";

/** An in-memory test rig implementing the onboarding seams with plain objects. */
function rig(opts: { gated?: boolean; connected?: string[]; now?: number } = {}) {
  const requests = new Map<string, SetupRequestRow>();
  const creds = new Map<string, ServiceCredentialRow>();
  const receipts: DnsReceiptRow[] = [];
  const submitted: Array<{ summary: string; payload: Record<string, unknown> }> = [];
  let approvalSeq = 0;
  let receiptSeq = 0;
  for (const k of opts.connected ?? []) {
    creds.set(k, {
      serviceKey: k,
      connected: true,
      status: "connected",
      fingerprint: "fp",
      envKeys: [],
      scopes: [],
      rotationReminderDays: 0,
      connectedAtMs: 0,
      revokedAtMs: null,
    });
  }
  const deps: OnboardingDeps = {
    setupRequests: {
      upsert: async (input) => {
        const existing = requests.get(input.serviceKey);
        const row: SetupRequestRow = {
          id: existing?.id ?? `req-${input.serviceKey}`,
          serviceKey: input.serviceKey,
          serviceKind: input.serviceKind,
          displayName: input.displayName,
          plan: input.plan,
          scopes: input.scopes,
          reason: input.reason,
          projectedCostCents: input.projectedCostCents,
          reversibility: input.reversibility,
          status: existing?.status ?? "requested",
          approvalRequestId: input.approvalRequestId ?? existing?.approvalRequestId ?? null,
          createdAtMs: 0,
          updatedAtMs: 0,
        };
        requests.set(input.serviceKey, row);
        return row;
      },
      list: async () => [...requests.values()],
      setStatus: async (_w, serviceKey, status) => {
        const r = requests.get(serviceKey);
        if (r) requests.set(serviceKey, { ...r, status });
      },
    },
    credentials: {
      set: async (input) => {
        const row: ServiceCredentialRow = {
          serviceKey: input.serviceKey,
          connected: true,
          status: "connected",
          fingerprint: "fp",
          envKeys: Object.keys(input.secrets),
          scopes: input.scopes ?? [],
          rotationReminderDays: input.rotationReminderDays ?? 0,
          connectedAtMs: opts.now ?? 0,
          revokedAtMs: null,
        };
        creds.set(input.serviceKey, row);
        return row;
      },
      list: async () => [...creds.values()],
      revoke: async (_w, serviceKey) => {
        const c = creds.get(serviceKey);
        if (c) creds.set(serviceKey, { ...c, connected: false, status: "revoked" });
      },
    },
    dnsReceipts: {
      record: async (input) => {
        for (const r of input.receipts) {
          receipts.push({
            id: `rec-${receiptSeq++}`,
            domain: input.domain,
            recordType: r.recordType,
            name: r.name,
            value: r.value,
            purpose: r.purpose,
            status: r.status,
            provider: input.provider,
            createdAtMs: 0,
          });
        }
      },
      list: async () => [...receipts],
    },
    approvals: {
      requiresApproval: async () => opts.gated ?? true,
      submit: async (input) => {
        submitted.push({ summary: input.summary, payload: input.payload });
        return { id: `appr-${approvalSeq++}` };
      },
    },
    dns: new DryRunDnsProvider(),
    resolveCaps: () => ONBOARDING_DEFAULTS,
    now: () => opts.now ?? 0,
  };
  return { deps, requests, creds, receipts, submitted, service: new OnboardingService(deps) };
}

const esp: RequiredService = {
  serviceKey: "sendgrid",
  serviceKind: "esp",
  displayName: "SendGrid",
  reason: "transactional email",
  projectedCostCents: 1500,
};
const registrar: RequiredService = {
  serviceKey: "namecheap",
  serviceKind: "registrar",
  displayName: "Namecheap",
  reason: "buy the domain",
  projectedCostCents: 1200,
};

describe("OnboardingService.fileSetupNeeds (acceptance 1 + 5)", () => {
  it("files a request + parks a #13 approval for each missing service", async () => {
    const r = rig({ gated: true });
    const filed = await r.service.fileSetupNeeds({
      workspaceId: "w1",
      required: [esp, registrar],
      requesterMemberId: "m1",
    });
    expect(filed.map((f) => f.spec.serviceKey).sort()).toEqual(["namecheap", "sendgrid"]);
    expect(filed.every((f) => f.approvalRequestId !== null)).toBe(true);
    expect(r.submitted).toHaveLength(2);
    // the registrar request is flagged irreversible (a money decision)
    const reg = filed.find((f) => f.spec.serviceKey === "namecheap")!;
    expect(reg.spec.reversibility).toBe("irreversible");
    expect(reg.spec.requiresHuman).toBe(true);
  });

  it("does not file or park an already-connected service", async () => {
    const r = rig({ gated: true, connected: ["sendgrid"] });
    const filed = await r.service.fileSetupNeeds({
      workspaceId: "w1",
      required: [esp, registrar],
      requesterMemberId: "m1",
    });
    expect(filed.map((f) => f.spec.serviceKey)).toEqual(["namecheap"]);
    expect(r.submitted).toHaveLength(1);
  });

  it("is idempotent: re-filing reuses the existing approval instead of stacking a second", async () => {
    const r = rig({ gated: true });
    await r.service.fileSetupNeeds({ workspaceId: "w1", required: [esp], requesterMemberId: "m1" });
    await r.service.fileSetupNeeds({ workspaceId: "w1", required: [esp], requesterMemberId: "m1" });
    expect(r.submitted).toHaveLength(1); // only one approval ever submitted
  });

  it("skips the approval when the policy does not gate (but still files the request)", async () => {
    const r = rig({ gated: false });
    const filed = await r.service.fileSetupNeeds({
      workspaceId: "w1",
      required: [esp],
      requesterMemberId: "m1",
    });
    expect(filed[0].approvalRequestId).toBeNull();
    expect(r.submitted).toHaveLength(0);
    expect(r.requests.get("sendgrid")).toBeDefined();
  });
});

describe("OnboardingService.connect / revoke (acceptance 2 + 4)", () => {
  it("connect seals credentials and flips the request to connected; returns no secrets", async () => {
    const r = rig({ gated: true });
    await r.service.fileSetupNeeds({ workspaceId: "w1", required: [esp], requesterMemberId: "m1" });
    const status = await r.service.connect({
      workspaceId: "w1",
      serviceKey: "sendgrid",
      secrets: { SENDGRID_API_KEY: "SG.secret" },
    });
    expect(status.connected).toBe(true);
    expect(status.envKeys).toEqual(["SENDGRID_API_KEY"]);
    expect(JSON.stringify(status)).not.toContain("SG.secret"); // never echoes the key
    expect(r.requests.get("sendgrid")!.status).toBe("connected");
  });

  it("revoke marks the credential revoked and reopens the setup request", async () => {
    const r = rig({ gated: true });
    await r.service.fileSetupNeeds({ workspaceId: "w1", required: [esp], requesterMemberId: "m1" });
    await r.service.connect({ workspaceId: "w1", serviceKey: "sendgrid", secrets: { K: "v" } });
    await r.service.revoke("w1", "sendgrid");
    expect(r.creds.get("sendgrid")!.connected).toBe(false);
    expect(r.requests.get("sendgrid")!.status).toBe("requested");
  });
});

describe("OnboardingService.checklist", () => {
  it("counts pending setup and surfaces capability state", async () => {
    const r = rig({ gated: true });
    await r.service.fileSetupNeeds({
      workspaceId: "w1",
      required: [esp, registrar],
      requesterMemberId: "m1",
    });
    const checklist = await r.service.checklist("w1", [
      { capability: "email_send", requiredServiceKeys: ["sendgrid"] },
    ]);
    expect(checklist.pendingSetupCount).toBe(2);
    expect(checklist.capabilities[0]).toMatchObject({ capability: "email_send", online: false });
  });
});

describe("OnboardingService.configureDns (acceptance 3)", () => {
  it("configures then verifies, writing receipts for both passes", async () => {
    const r = rig();
    const out = await r.service.configureDns({
      workspaceId: "w1",
      plan: { domain: "launch.example.com", spfIncludes: ["sendgrid.net"], dmarcRua: "d@x.com" },
    });
    expect(out.domain).toBe("launch.example.com");
    expect(out.summary.allVerified).toBe(true);
    // both configure + verify passes were recorded
    const statuses = new Set(r.receipts.map((rec) => rec.status));
    expect(statuses.has("configured")).toBe(true);
    expect(statuses.has("verified")).toBe(true);
    // SPF + DMARC receipts exist
    expect(r.receipts.some((rec) => rec.purpose === "spf")).toBe(true);
    expect(r.receipts.some((rec) => rec.purpose === "dmarc")).toBe(true);
  });
});
