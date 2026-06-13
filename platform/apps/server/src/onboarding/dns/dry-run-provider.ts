import type {
  DnsConfigureInput,
  DnsConfigureOutcome,
  DnsProvider,
  DnsVerifyInput,
} from "./provider.js";

/**
 * The default DNS provider (#192, ADR-0192): zero network, deterministic. `configure` records every
 * planned record as `configured`; `verify` records every record as `verified`. This is what tests, CI,
 * and the demo run — the receipts are real rows, but no registrar is touched and no spend occurs. A real
 * deployment selects a live adapter (lazy-loaded) via the factory. Mirrors `DryRunDeployProvider` (#73).
 */
export class DryRunDnsProvider implements DnsProvider {
  readonly kind = "dryrun";

  configure(input: DnsConfigureInput): Promise<DnsConfigureOutcome> {
    input.onLog?.(`[dryrun] configuring ${input.records.length} record(s) for ${input.domain}`);
    return Promise.resolve({
      domain: input.domain,
      provider: this.kind,
      receipts: input.records.map((r) => ({
        recordType: r.recordType,
        name: r.name,
        value: r.value,
        purpose: r.purpose,
        status: "configured" as const,
        detail: { dryRun: true },
      })),
    });
  }

  verify(input: DnsVerifyInput): Promise<DnsConfigureOutcome> {
    input.onLog?.(`[dryrun] verifying ${input.records.length} record(s) for ${input.domain}`);
    return Promise.resolve({
      domain: input.domain,
      provider: this.kind,
      receipts: input.records.map((r) => ({
        recordType: r.recordType,
        name: r.name,
        value: r.value,
        purpose: r.purpose,
        status: "verified" as const,
        detail: { dryRun: true },
      })),
    });
  }
}
