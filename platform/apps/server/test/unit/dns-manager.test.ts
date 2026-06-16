import { describe, it, expect } from "vitest";
import { DnsManager, type DnsReceiptSink } from "../../src/onboarding/dns/manager.js";
import type {
  DnsConfigureInput,
  DnsConfigureOutcome,
  DnsProvider,
  DnsReceiptResult,
  DnsVerifyInput,
} from "../../src/onboarding/dns/provider.js";

/**
 * DnsManager (#264) — the service the three DNS-blocked lanes call. Driven by an injected fake provider
 * (records the records it was handed) + a fake receipt sink, so we prove each lane PLANS the right records
 * and that every call writes immutable receipts for both the configure and the verify pass — with no money
 * gate and no send/spend seam anywhere on the manager (structurally money-free + injection-proof).
 */

function fakeProvider(): DnsProvider & {
  configureCalls: DnsConfigureInput[];
  verifyCalls: DnsVerifyInput[];
} {
  const configureCalls: DnsConfigureInput[] = [];
  const verifyCalls: DnsVerifyInput[] = [];
  const mk = (input: DnsConfigureInput, status: DnsReceiptResult["status"]): DnsConfigureOutcome => ({
    domain: input.domain,
    provider: "fake",
    receipts: input.records.map((r) => ({ ...r, status })),
  });
  return {
    kind: "fake",
    configureCalls,
    verifyCalls,
    async configure(input) {
      configureCalls.push(input);
      return mk(input, "configured");
    },
    async verify(input) {
      verifyCalls.push(input);
      return mk(input, "verified");
    },
  };
}

function fakeSink(): DnsReceiptSink & { batches: Array<{ provider: string; receipts: DnsReceiptResult[] }> } {
  const batches: Array<{ provider: string; receipts: DnsReceiptResult[] }> = [];
  return {
    batches,
    async record(input) {
      batches.push({ provider: input.provider, receipts: input.receipts });
    },
  };
}

function makeManager() {
  const provider = fakeProvider();
  const sink = fakeSink();
  const resolved: string[] = [];
  const manager = new DnsManager({
    resolveProvider: async (workspaceId) => {
      resolved.push(workspaceId);
      return provider;
    },
    receipts: sink,
  });
  return { manager, provider, sink, resolved };
}

describe("DnsManager.verifyDomain (lane 1 — Search Console)", () => {
  it("plans a google-site-verification TXT by default and records configure+verify receipts", async () => {
    const { manager, provider, sink, resolved } = makeManager();
    const out = await manager.verifyDomain({ workspaceId: "w1", domain: "acme.com", token: "gtok" });

    expect(resolved).toEqual(["w1"]);
    const planned = provider.configureCalls[0]?.records ?? [];
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ recordType: "TXT", purpose: "verification", value: "google-site-verification=gtok" });
    expect(out.summary.allVerified).toBe(true);
    // One batch from configure, one from verify — immutable audit of both passes.
    expect(sink.batches.map((b) => b.receipts[0]?.status)).toEqual(["configured", "verified"]);
  });

  it("plans the reload ownership token when kind=reload", async () => {
    const { manager, provider } = makeManager();
    await manager.verifyDomain({ workspaceId: "w1", domain: "acme.com", token: "rtok", kind: "reload" });
    expect(provider.configureCalls[0]?.records[0]?.value).toBe("reload-verification=rtok");
  });
});

describe("DnsManager.ensureEmailAuth (lane 2 — SPF/DKIM/DMARC)", () => {
  it("plans SPF + DKIM + DMARC when a DKIM key is supplied", async () => {
    const { manager, provider } = makeManager();
    await manager.ensureEmailAuth({
      workspaceId: "w1",
      domain: "acme.com",
      spfIncludes: ["sendgrid.net"],
      dkim: { selector: "s1", publicKey: "PUB" },
      dmarcRua: "dmarc@acme.com",
    });
    const purposes = (provider.configureCalls[0]?.records ?? []).map((r) => r.purpose);
    expect(purposes).toEqual(["spf", "dkim", "dmarc"]);
  });

  it("omits DKIM when no key is supplied (SPF + DMARC only)", async () => {
    const { manager, provider } = makeManager();
    await manager.ensureEmailAuth({ workspaceId: "w1", domain: "acme.com", spfIncludes: ["sendgrid.net"] });
    expect((provider.configureCalls[0]?.records ?? []).map((r) => r.purpose)).toEqual(["spf", "dmarc"]);
  });
});

describe("DnsManager.ensureSiteCname (lane 3 — hosted pages)", () => {
  it("plans a CNAME + CAA (for the TLS cert) by default", async () => {
    const { manager, provider } = makeManager();
    await manager.ensureSiteCname({ workspaceId: "w1", domain: "acme.com", target: "cname.vercel-dns.com" });
    const records = provider.configureCalls[0]?.records ?? [];
    expect(records.map((r) => r.purpose)).toEqual(["dns", "ssl"]);
    expect(records[0]).toMatchObject({ recordType: "CNAME", name: "@", value: "cname.vercel-dns.com" });
  });

  it("supports a www host and skips CAA when ssl=false", async () => {
    const { manager, provider } = makeManager();
    await manager.ensureSiteCname({ workspaceId: "w1", domain: "acme.com", target: "t", name: "www", ssl: false });
    const records = provider.configureCalls[0]?.records ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ recordType: "CNAME", name: "www" });
  });
});

describe("DnsManager.setupDomain (one-time connect — all lanes)", () => {
  it("plans verification + hosted-pages CNAME/CAA + email auth in one pass", async () => {
    const { manager, provider } = makeManager();
    const out = await manager.setupDomain({
      workspaceId: "w1",
      domain: "acme.com",
      googleVerificationToken: "gtok",
      appTarget: "cname.vercel-dns.com",
      spfIncludes: ["sendgrid.net"],
      dkim: { selector: "s1", publicKey: "PUB" },
      dmarcRua: "dmarc@acme.com",
    });
    const purposes = (provider.configureCalls[0]?.records ?? []).map((r) => r.purpose);
    expect(purposes).toEqual(["verification", "dns", "ssl", "spf", "dkim", "dmarc"]);
    expect(out.summary.allVerified).toBe(true);
  });

  it("plans only the lanes whose inputs are present (verification-only)", async () => {
    const { manager, provider } = makeManager();
    await manager.setupDomain({ workspaceId: "w1", domain: "acme.com", googleVerificationToken: "gtok" });
    expect((provider.configureCalls[0]?.records ?? []).map((r) => r.purpose)).toEqual(["verification"]);
  });
});
