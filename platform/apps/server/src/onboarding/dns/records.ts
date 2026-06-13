/**
 * Pure DNS / email-authentication record builders (#192, ADR-0192, acceptance 3). After the owner buys
 * the domain (the money step), the agent configures these records autonomously. No IO and no clock, so
 * they're unit-tested offline. SPF/DKIM/DMARC values are PUBLIC (published in DNS), never secrets.
 */

export type DnsRecordType = "A" | "CNAME" | "TXT" | "MX" | "CAA";
export type DnsPurpose = "dns" | "ssl" | "spf" | "dkim" | "dmarc" | "verification";

export interface DnsRecordSpec {
  recordType: DnsRecordType;
  /** The host name, relative to the domain (`@` for apex). */
  name: string;
  value: string;
  purpose: DnsPurpose;
}

/** SPF (sender policy) TXT record at the apex. `~all` (softfail) by default; `-all` to hard-fail. */
export function buildSpfRecord(opts: { includes?: string[]; all?: "~all" | "-all" } = {}): DnsRecordSpec {
  const includes = (opts.includes ?? []).map((i) => `include:${i}`);
  const all = opts.all ?? "~all";
  const value = ["v=spf1", ...includes, all].join(" ");
  return { recordType: "TXT", name: "@", value, purpose: "spf" };
}

/** DKIM public-key TXT record at `<selector>._domainkey`. The private key never leaves the ESP. */
export function buildDkimRecord(selector: string, publicKey: string): DnsRecordSpec {
  return {
    recordType: "TXT",
    name: `${selector}._domainkey`,
    value: `v=DKIM1; k=rsa; p=${publicKey}`,
    purpose: "dkim",
  };
}

/**
 * DMARC policy TXT record at `_dmarc`. Defaults to `p=none` (monitor-only) so a freshly-configured
 * domain doesn't start bouncing legitimate mail before SPF/DKIM alignment is proven — the agent can
 * tighten to `quarantine`/`reject` later. `rua` is the aggregate-report mailbox.
 */
export function buildDmarcRecord(
  opts: { policy?: "none" | "quarantine" | "reject"; rua?: string } = {},
): DnsRecordSpec {
  const policy = opts.policy ?? "none";
  const parts = ["v=DMARC1", `p=${policy}`];
  if (opts.rua) parts.push(`rua=mailto:${opts.rua}`);
  return { recordType: "TXT", name: "_dmarc", value: parts.join("; "), purpose: "dmarc" };
}

/** Ownership-verification TXT record (the registrar/ESP hands the agent a token to publish). */
export function buildVerificationRecord(token: string, name = "@"): DnsRecordSpec {
  return { recordType: "TXT", name, value: `reload-verification=${token}`, purpose: "verification" };
}

/** A CAA record authorizing the ACME CA to issue SSL certs for the domain (acceptance 3 SSL). */
export function buildCaaRecord(ca = "letsencrypt.org"): DnsRecordSpec {
  return { recordType: "CAA", name: "@", value: `0 issue "${ca}"`, purpose: "ssl" };
}

export interface DnsPlanInput {
  domain: string;
  /** Where the app is hosted (CNAME target), e.g. `cname.vercel-dns.com`. */
  appTarget?: string;
  /** SPF includes (the ESP's sending hosts). */
  spfIncludes?: string[];
  /** DKIM selector + public key from the ESP. */
  dkim?: { selector: string; publicKey: string };
  /** DMARC aggregate-report mailbox. */
  dmarcRua?: string;
  /** Ownership-verification token. */
  verificationToken?: string;
}

/**
 * The full set of records the agent plans for a domain: app pointing (CNAME/SSL), email authentication
 * (SPF/DKIM/DMARC), and ownership verification. Only the records whose inputs are present are emitted, so
 * a domain used purely for email gets no app CNAME, and vice-versa. Deterministic ordering.
 */
export function planDomainRecords(input: DnsPlanInput): DnsRecordSpec[] {
  const records: DnsRecordSpec[] = [];
  if (input.verificationToken) records.push(buildVerificationRecord(input.verificationToken));
  if (input.appTarget) {
    records.push({ recordType: "CNAME", name: "@", value: input.appTarget, purpose: "dns" });
    records.push(buildCaaRecord());
  }
  // Email authentication: SPF + DMARC are always planned for a sending domain; DKIM only with a key.
  records.push(buildSpfRecord({ includes: input.spfIncludes }));
  if (input.dkim) records.push(buildDkimRecord(input.dkim.selector, input.dkim.publicKey));
  records.push(buildDmarcRecord({ rua: input.dmarcRua }));
  return records;
}
