import type { DnsRecordSpec, DnsPurpose, DnsRecordType } from "./records.js";

/**
 * Provider seam for DNS / SSL / email-auth configuration (#192, ADR-0192), mirroring the #73
 * `DeployProvider`. The real registrar/DNS adapter (Cloudflare, etc.) implements this behind a dynamic
 * import so its SDK is an OPTIONAL dependency the test/CI path never loads; the default `DryRunDnsProvider`
 * implements the whole surface with zero network so tests, CI, and the demo run for free.
 *
 * Configuring DNS is REVERSIBLE (records can be changed back), so — unlike buying the domain (the money
 * step the owner does) — the agent does it autonomously and writes a RECEIPT per record (acceptance 3).
 * `verify` re-checks the published records (production-grounded verification, #200 failure-mode 3).
 */
export interface DnsProvider {
  /** Stable provider kind (`dryrun` | `cloudflare` | ...). */
  readonly kind: string;
  /** Create the planned records at the registrar; resolve with a receipt per record. */
  configure(input: DnsConfigureInput): Promise<DnsConfigureOutcome>;
  /** Re-check that the records resolve as published (the reality-touching verification step). */
  verify(input: DnsVerifyInput): Promise<DnsConfigureOutcome>;
}

export interface DnsConfigureInput {
  domain: string;
  records: DnsRecordSpec[];
  /** Stream one raw provider log line (the manager/service may redact before persisting). */
  onLog?: (line: string) => void;
}

export interface DnsVerifyInput {
  domain: string;
  records: DnsRecordSpec[];
  onLog?: (line: string) => void;
}

/** The outcome of a single record's configure/verify — the durable receipt content (acceptance 3). */
export interface DnsReceiptResult {
  recordType: DnsRecordType;
  name: string;
  value: string;
  purpose: DnsPurpose;
  status: "configured" | "verified" | "failed";
  detail?: Record<string, unknown>;
}

export interface DnsConfigureOutcome {
  domain: string;
  provider: string;
  receipts: DnsReceiptResult[];
}

/** Roll a set of receipts up to counts — the at-a-glance summary the checklist/console shows. */
export function summarizeReceipts(receipts: DnsReceiptResult[]): {
  total: number;
  configured: number;
  verified: number;
  failed: number;
  allVerified: boolean;
} {
  const configured = receipts.filter((r) => r.status === "configured").length;
  const verified = receipts.filter((r) => r.status === "verified").length;
  const failed = receipts.filter((r) => r.status === "failed").length;
  return {
    total: receipts.length,
    configured,
    verified,
    failed,
    allVerified: receipts.length > 0 && failed === 0 && configured === 0,
  };
}
