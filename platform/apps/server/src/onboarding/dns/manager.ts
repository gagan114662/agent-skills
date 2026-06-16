import {
  buildCaaRecord,
  buildCnameRecord,
  buildDkimRecord,
  buildDmarcRecord,
  buildGoogleVerificationRecord,
  buildSpfRecord,
  buildVerificationRecord,
  type DnsRecordSpec,
} from "./records.js";
import { summarizeReceipts, type DnsProvider, type DnsReceiptResult } from "./provider.js";

/**
 * DnsManager (#264) — the one service the three DNS-blocked lanes call so a NON-TECHNICAL user never edits
 * a record by hand. After a one-time domain connect, each lane asks the manager to publish + verify the
 * records it needs through whatever {@link DnsProvider} the workspace connected (Cloudflare today; the
 * dry-run default when nothing is connected):
 *
 *  - {@link verifyDomain}    — Search Console (or reload) ownership TXT.
 *  - {@link ensureEmailAuth} — SPF / DKIM / DMARC for the connected ESP.
 *  - {@link ensureSiteCname} — the CNAME (+ CAA) that attaches a custom domain to hosted pages.
 *  - {@link setupDomain}     — runs every lane the inputs cover in one pass (the "connect a domain" flow).
 *
 * Every call configures (write), records an immutable receipt per record, re-reads to VERIFY
 * (production-grounded, #200 FM-3), records the verified receipts, and returns the verified outcome + a
 * roll-up. The manager has NO approvals/send/spend seam by construction: writing DNS is reversible and
 * money-free (#243 — registrar connect/use is autonomous), and the connector returns DATA-only receipts,
 * so a poisoned registrar response can never reach an action (injection-quarantine intact, #223).
 */

/** Append-only receipt sink (the #192 `dns_receipts` store; injected so the manager is unit-testable). */
export interface DnsReceiptSink {
  record(input: {
    workspaceId: string;
    domain: string;
    provider: string;
    receipts: DnsReceiptResult[];
  }): Promise<void>;
}

export interface DnsManagerDeps {
  /** Resolve the workspace's connected DNS provider (Cloudflare w/ vault token, else dry-run). */
  resolveProvider: (workspaceId: string) => Promise<DnsProvider>;
  receipts: DnsReceiptSink;
}

/** The verified outcome a lane hands back to its caller / the route. */
export interface DnsLaneOutcome {
  domain: string;
  provider: string;
  records: DnsReceiptResult[];
  summary: ReturnType<typeof summarizeReceipts>;
}

export class DnsManager {
  constructor(private readonly deps: DnsManagerDeps) {}

  /**
   * Lane 1 — domain verification. Publishes the ownership TXT a verifier handed the user (Google Search
   * Console by default — `google-site-verification=<token>`; `reload` for the platform's own token) and
   * verifies it resolves. Unblocks Search Console with no manual DNS.
   */
  verifyDomain(input: {
    workspaceId: string;
    domain: string;
    token: string;
    kind?: "google" | "reload";
    onLog?: (line: string) => void;
  }): Promise<DnsLaneOutcome> {
    const record =
      (input.kind ?? "google") === "reload"
        ? buildVerificationRecord(input.token)
        : buildGoogleVerificationRecord(input.token);
    return this.apply(input.workspaceId, input.domain, [record], input.onLog);
  }

  /**
   * Lane 2 — email sender authentication. Publishes SPF + (when the ESP gives a key) DKIM + DMARC so mail
   * from the domain authenticates. SPF + DMARC are always planned for a sending domain; DKIM only with a
   * public key. Unblocks ESP deliverability with no manual DNS.
   */
  ensureEmailAuth(input: {
    workspaceId: string;
    domain: string;
    spfIncludes?: string[];
    dkim?: { selector: string; publicKey: string };
    dmarcRua?: string;
    dmarcPolicy?: "none" | "quarantine" | "reject";
    onLog?: (line: string) => void;
  }): Promise<DnsLaneOutcome> {
    const records: DnsRecordSpec[] = [buildSpfRecord({ includes: input.spfIncludes })];
    if (input.dkim) records.push(buildDkimRecord(input.dkim.selector, input.dkim.publicKey));
    records.push(buildDmarcRecord({ policy: input.dmarcPolicy, rua: input.dmarcRua }));
    return this.apply(input.workspaceId, input.domain, records, input.onLog);
  }

  /**
   * Lane 3 — attach a custom domain to hosted pages. Publishes the CNAME pointing the host (`@` apex or
   * e.g. `www`) at the hosting target, plus a CAA authorizing the ACME CA to issue the TLS cert (unless
   * `ssl: false`). Unblocks custom-domain hosting with no manual DNS.
   */
  ensureSiteCname(input: {
    workspaceId: string;
    domain: string;
    target: string;
    name?: string;
    ssl?: boolean;
    onLog?: (line: string) => void;
  }): Promise<DnsLaneOutcome> {
    const records: DnsRecordSpec[] = [buildCnameRecord(input.target, input.name)];
    if (input.ssl !== false) records.push(buildCaaRecord());
    return this.apply(input.workspaceId, input.domain, records, input.onLog);
  }

  /**
   * The one-time "connect a domain" flow (acceptance): run every lane whose inputs are present in a single
   * pass — verification + email auth + hosted-pages CNAME — so connecting a domain sets all three up with
   * no manual DNS. Records whose inputs are absent are simply not planned.
   */
  setupDomain(input: {
    workspaceId: string;
    domain: string;
    googleVerificationToken?: string;
    reloadVerificationToken?: string;
    appTarget?: string;
    spfIncludes?: string[];
    dkim?: { selector: string; publicKey: string };
    dmarcRua?: string;
    dmarcPolicy?: "none" | "quarantine" | "reject";
    /** When false, skip email-auth records even if no email inputs are given (default: plan when any are). */
    email?: boolean;
    onLog?: (line: string) => void;
  }): Promise<DnsLaneOutcome> {
    const records: DnsRecordSpec[] = [];
    if (input.googleVerificationToken)
      records.push(buildGoogleVerificationRecord(input.googleVerificationToken));
    if (input.reloadVerificationToken)
      records.push(buildVerificationRecord(input.reloadVerificationToken));
    if (input.appTarget) {
      records.push(buildCnameRecord(input.appTarget));
      records.push(buildCaaRecord());
    }
    const wantsEmail =
      input.email ?? (input.spfIncludes !== undefined || !!input.dkim || !!input.dmarcRua);
    if (wantsEmail) {
      records.push(buildSpfRecord({ includes: input.spfIncludes }));
      if (input.dkim) records.push(buildDkimRecord(input.dkim.selector, input.dkim.publicKey));
      records.push(buildDmarcRecord({ policy: input.dmarcPolicy, rua: input.dmarcRua }));
    }
    return this.apply(input.workspaceId, input.domain, records, input.onLog);
  }

  /**
   * The shared write→receipt→verify→receipt cycle every lane runs. Resolves the workspace's provider,
   * configures the records (immutable receipt per record), then re-reads to verify (records those too),
   * and returns the verified outcome + summary. Mirrors `OnboardingService.configureDns` so the audit
   * trail is identical regardless of which lane triggered it.
   */
  private async apply(
    workspaceId: string,
    domain: string,
    records: DnsRecordSpec[],
    onLog?: (line: string) => void,
  ): Promise<DnsLaneOutcome> {
    // No records to plan (e.g. setupDomain called with no lane inputs): there is nothing to write or
    // verify, so don't resolve a provider, hit the registrar, or append an empty receipt batch.
    if (records.length === 0) {
      return {
        domain,
        provider: "none",
        records: [],
        // Nothing requested ⇒ nothing outstanding: vacuously verified (no record is missing or wrong).
        summary: { total: 0, configured: 0, verified: 0, failed: 0, allVerified: true },
      };
    }
    const provider = await this.deps.resolveProvider(workspaceId);
    const configured = await provider.configure({ domain, records, onLog });
    await this.deps.receipts.record({
      workspaceId,
      domain: configured.domain,
      provider: configured.provider,
      receipts: configured.receipts,
    });
    // If configure failed for every record (bad token / unresolvable zone), verify would re-run the exact
    // same failing requests and write a duplicate failed batch — short-circuit on the recorded configure.
    if (configured.receipts.length > 0 && configured.receipts.every((r) => r.status === "failed")) {
      return {
        domain: configured.domain,
        provider: configured.provider,
        records: configured.receipts,
        summary: summarizeReceipts(configured.receipts),
      };
    }
    const verified = await provider.verify({ domain, records, onLog });
    await this.deps.receipts.record({
      workspaceId,
      domain: verified.domain,
      provider: verified.provider,
      receipts: verified.receipts,
    });
    return {
      domain: verified.domain,
      provider: verified.provider,
      records: verified.receipts,
      summary: summarizeReceipts(verified.receipts),
    };
  }
}
