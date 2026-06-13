import { describe, it, expect } from "vitest";
import {
  buildSpfRecord,
  buildDkimRecord,
  buildDmarcRecord,
  buildVerificationRecord,
  buildCaaRecord,
  planDomainRecords,
} from "../../src/onboarding/dns/records.js";
import { summarizeReceipts } from "../../src/onboarding/dns/provider.js";
import { DryRunDnsProvider } from "../../src/onboarding/dns/dry-run-provider.js";
import { createDnsProvider } from "../../src/onboarding/dns/factory.js";

describe("DNS record builders (acceptance 3)", () => {
  it("builds an SPF record with includes and a softfail by default", () => {
    const r = buildSpfRecord({ includes: ["sendgrid.net", "spf.example.com"] });
    expect(r).toEqual({
      recordType: "TXT",
      name: "@",
      value: "v=spf1 include:sendgrid.net include:spf.example.com ~all",
      purpose: "spf",
    });
  });

  it("supports a hard-fail SPF", () => {
    expect(buildSpfRecord({ all: "-all" }).value).toBe("v=spf1 -all");
  });

  it("builds a DKIM record at <selector>._domainkey with the public key", () => {
    const r = buildDkimRecord("s1", "MIGfMA0...");
    expect(r.name).toBe("s1._domainkey");
    expect(r.value).toBe("v=DKIM1; k=rsa; p=MIGfMA0...");
    expect(r.purpose).toBe("dkim");
  });

  it("builds a monitor-only DMARC by default and includes rua when given", () => {
    expect(buildDmarcRecord().value).toBe("v=DMARC1; p=none");
    expect(buildDmarcRecord({ policy: "reject", rua: "dmarc@example.com" }).value).toBe(
      "v=DMARC1; p=reject; rua=mailto:dmarc@example.com",
    );
  });

  it("builds a verification TXT and a CAA for SSL", () => {
    expect(buildVerificationRecord("tok123").value).toBe("reload-verification=tok123");
    expect(buildCaaRecord().value).toBe('0 issue "letsencrypt.org"');
    expect(buildCaaRecord().purpose).toBe("ssl");
  });
});

describe("planDomainRecords", () => {
  it("plans app + email-auth + verification records when all inputs are present", () => {
    const records = planDomainRecords({
      domain: "launch.example.com",
      appTarget: "cname.vercel-dns.com",
      spfIncludes: ["sendgrid.net"],
      dkim: { selector: "s1", publicKey: "PUB" },
      dmarcRua: "dmarc@example.com",
      verificationToken: "tok",
    });
    const purposes = records.map((r) => r.purpose);
    expect(purposes).toContain("verification");
    expect(purposes).toContain("dns");
    expect(purposes).toContain("ssl");
    expect(purposes).toContain("spf");
    expect(purposes).toContain("dkim");
    expect(purposes).toContain("dmarc");
  });

  it("omits the app CNAME/SSL + DKIM for an email-only domain", () => {
    const records = planDomainRecords({ domain: "mail.example.com", spfIncludes: ["sendgrid.net"] });
    const purposes = records.map((r) => r.purpose);
    expect(purposes).not.toContain("dns");
    expect(purposes).not.toContain("ssl");
    expect(purposes).not.toContain("dkim");
    expect(purposes).toEqual(["spf", "dmarc"]);
  });
});

describe("DryRunDnsProvider (default, no network)", () => {
  it("configures every record as configured and verifies every record as verified", async () => {
    const provider = new DryRunDnsProvider();
    const records = planDomainRecords({ domain: "x.com", spfIncludes: [] });
    const configured = await provider.configure({ domain: "x.com", records });
    expect(configured.provider).toBe("dryrun");
    expect(configured.receipts.every((r) => r.status === "configured")).toBe(true);
    const verified = await provider.verify({ domain: "x.com", records });
    expect(verified.receipts.every((r) => r.status === "verified")).toBe(true);
  });

  it("streams a log line when onLog is provided", async () => {
    const provider = new DryRunDnsProvider();
    const lines: string[] = [];
    await provider.configure({ domain: "x.com", records: [], onLog: (l) => lines.push(l) });
    expect(lines.length).toBe(1);
  });
});

describe("createDnsProvider", () => {
  it("defaults to the dry-run provider with zero network", () => {
    expect(createDnsProvider().kind).toBe("dryrun");
    expect(createDnsProvider({ provider: "cloudflare" }).kind).toBe("dryrun"); // no live adapter yet → safe default
  });

  it("returns an injected provider verbatim", () => {
    const fake = new DryRunDnsProvider();
    expect(createDnsProvider({}, fake)).toBe(fake);
  });
});

describe("summarizeReceipts", () => {
  it("rolls receipts up to counts and flags allVerified", () => {
    const verified = summarizeReceipts([
      { recordType: "TXT", name: "@", value: "v", purpose: "spf", status: "verified" },
      { recordType: "TXT", name: "_dmarc", value: "v", purpose: "dmarc", status: "verified" },
    ]);
    expect(verified.verified).toBe(2);
    expect(verified.allVerified).toBe(true);

    const mixed = summarizeReceipts([
      { recordType: "TXT", name: "@", value: "v", purpose: "spf", status: "configured" },
      { recordType: "TXT", name: "_dmarc", value: "v", purpose: "dmarc", status: "failed" },
    ]);
    expect(mixed.configured).toBe(1);
    expect(mixed.failed).toBe(1);
    expect(mixed.allVerified).toBe(false);
  });
});
