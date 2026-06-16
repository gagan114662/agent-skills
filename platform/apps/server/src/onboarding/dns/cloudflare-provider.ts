import type {
  DnsConfigureInput,
  DnsConfigureOutcome,
  DnsProvider,
  DnsReceiptResult,
  DnsVerifyInput,
} from "./provider.js";
import type { DnsRecordSpec } from "./records.js";

/**
 * Live Cloudflare DNS connector (#264) — the first real {@link DnsProvider}. After a one-time domain
 * connect (the user pastes a scoped Cloudflare API token into the #192 vault, kind `registrar` →
 * AUTONOMOUS, not a money action), the agent READS and WRITES the records ipop needs across all three
 * DNS-blocked lanes (Search Console verification TXT, email auth SPF/DKIM/DMARC, hosted-pages CNAME) —
 * **no record is ever edited by hand by the non-technical user**.
 *
 * **Dependency-free**: the Cloudflare REST API over global `fetch`, no SDK (mirrors
 * `GitHubPagesPublishProvider` / `GitHubSitePrProvider`). **Lazy**: only constructed by the factory when
 * `dnsProvider: "cloudflare"` AND a token resolves, so the default path never touches the network.
 *
 * **Connector seam**: this implements the generic {@link DnsProvider} interface, so GoDaddy / Namecheap /
 * Route53 each slot in as a sibling class behind the same `configure`/`verify` contract with no change to
 * the manager or the lanes — only a new `case` in `createDnsProvider`.
 *
 * **Injection-safe**: the provider returns structured {@link DnsReceiptResult}s only. Registrar API
 * responses (ids, error strings) are captured into the receipt `detail` for human-facing display (and
 * truncated), never parsed back into an autonomous action or a prompt. The token lives only in the
 * `Authorization` header and is NEVER written to a log line or a receipt.
 */
export interface CloudflareDnsProviderOptions {
  /** Scoped Cloudflare API token (Zone:DNS:Edit + Zone:Read), resolved per-workspace from the vault. */
  token: string;
  /** Override the API base (tests). Defaults to the public Cloudflare v4 API. */
  apiBase?: string;
}

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

export class CloudflareDnsProvider implements DnsProvider {
  readonly kind = "cloudflare" as const;
  private readonly token: string;
  private readonly apiBase: string;

  constructor(opts: CloudflareDnsProviderOptions) {
    this.token = opts.token;
    this.apiBase = opts.apiBase ?? CLOUDFLARE_API;
  }

  /** Create/update each planned record at Cloudflare; resolve with one receipt per record. Never throws. */
  async configure(input: DnsConfigureInput): Promise<DnsConfigureOutcome> {
    return this.run(input, "configure");
  }

  /** Re-read each record from Cloudflare and confirm it resolves as published. Never throws. */
  async verify(input: DnsVerifyInput): Promise<DnsConfigureOutcome> {
    return this.run(input, "verify");
  }

  private async run(
    input: DnsConfigureInput | DnsVerifyInput,
    mode: "configure" | "verify",
  ): Promise<DnsConfigureOutcome> {
    if (!this.token) {
      return this.allFailed(
        input,
        'dnsProvider: "cloudflare" requires a Cloudflare API token (connect one in onboarding) — falling back is automatic.',
      );
    }
    let zoneId: string;
    try {
      zoneId = await this.resolveZoneId(input.domain, input.onLog);
    } catch (err) {
      return this.allFailed(input, errMsg(err));
    }
    const receipts: DnsReceiptResult[] = [];
    for (const spec of input.records) {
      receipts.push(
        mode === "configure"
          ? await this.configureOne(zoneId, input.domain, spec, input.onLog)
          : await this.verifyOne(zoneId, input.domain, spec, input.onLog),
      );
    }
    return { domain: input.domain, provider: this.kind, receipts };
  }

  /**
   * Resolve the Cloudflare zone that owns the domain. A connected host can be a sub-domain
   * (`launch.example.com`) while the zone is the registrable apex (`example.com`), so we walk the labels
   * from the most specific candidate up to the two-label apex and take the first zone Cloudflare knows.
   */
  private async resolveZoneId(domain: string, onLog?: (l: string) => void): Promise<string> {
    const labels = domain.replace(/\.$/, "").split(".");
    for (let i = 0; i + 2 <= labels.length; i++) {
      const candidate = labels.slice(i).join(".");
      const res = await this.api(`/zones?name=${encodeURIComponent(candidate)}`);
      const zone = (res.result as Array<{ id: string; name: string }> | undefined)?.[0];
      if (zone?.id) {
        onLog?.(`[cloudflare] zone ${candidate} → ${zone.id.slice(0, 8)}…`);
        return zone.id;
      }
    }
    throw new Error(`no Cloudflare zone found for ${domain} (is the domain connected to this account?)`);
  }

  private async configureOne(
    zoneId: string,
    domain: string,
    spec: DnsRecordSpec,
    onLog?: (l: string) => void,
  ): Promise<DnsReceiptResult> {
    const fqdn = toFqdn(spec.name, domain);
    try {
      const existing = await this.findRecord(zoneId, spec.recordType, fqdn);
      const payload = toCloudflarePayload(spec, fqdn);
      const body = await this.api(
        existing ? `/zones/${zoneId}/dns_records/${existing.id}` : `/zones/${zoneId}/dns_records`,
        { method: existing ? "PUT" : "POST", body: JSON.stringify(payload) },
      );
      const id = (body.result as { id?: string } | undefined)?.id ?? existing?.id;
      const action = existing ? "updated" : "created";
      onLog?.(`[cloudflare] ${action} ${spec.recordType} ${fqdn} (${spec.purpose})`);
      return receipt(spec, "configured", { action, recordId: id, zoneId });
    } catch (err) {
      return receipt(spec, "failed", { error: errMsg(err) });
    }
  }

  private async verifyOne(
    zoneId: string,
    domain: string,
    spec: DnsRecordSpec,
    onLog?: (l: string) => void,
  ): Promise<DnsReceiptResult> {
    const fqdn = toFqdn(spec.name, domain);
    try {
      const found = await this.findRecord(zoneId, spec.recordType, fqdn);
      if (found && recordMatches(spec, found)) {
        onLog?.(`[cloudflare] verified ${spec.recordType} ${fqdn}`);
        return receipt(spec, "verified", { recordId: found.id, zoneId });
      }
      return receipt(spec, "failed", {
        zoneId,
        found: found ? truncate(found.content ?? JSON.stringify(found.data ?? {})) : null,
        reason: found ? "value mismatch" : "record not found",
      });
    } catch (err) {
      return receipt(spec, "failed", { error: errMsg(err) });
    }
  }

  /** Look up an existing record of a type at a FQDN (the read half the connector needs). */
  private async findRecord(
    zoneId: string,
    type: string,
    fqdn: string,
  ): Promise<CloudflareRecord | undefined> {
    const res = await this.api(
      `/zones/${zoneId}/dns_records?type=${encodeURIComponent(type)}&name=${encodeURIComponent(fqdn)}`,
    );
    return (res.result as CloudflareRecord[] | undefined)?.[0];
  }

  /** One Cloudflare API call. Throws on a non-2xx or `success: false` body. Token never logged. */
  private async api(path: string, init?: RequestInit): Promise<CloudflareEnvelope> {
    const res = await fetch(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
    let body: CloudflareEnvelope;
    try {
      body = (await res.json()) as CloudflareEnvelope;
    } catch {
      body = { success: res.ok };
    }
    if (!res.ok || body.success === false) {
      const detail = body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
      throw new Error(`cloudflare ${path.split("?")[0]} failed: ${truncate(detail)}`);
    }
    return body;
  }

  private allFailed(input: { domain: string; records: DnsRecordSpec[] }, error: string): DnsConfigureOutcome {
    return {
      domain: input.domain,
      provider: this.kind,
      receipts: input.records.map((spec) => receipt(spec, "failed", { error: truncate(error) })),
    };
  }
}

interface CloudflareRecord {
  id: string;
  type: string;
  name: string;
  content?: string;
  data?: Record<string, unknown>;
}

interface CloudflareEnvelope {
  success: boolean;
  result?: unknown;
  errors?: Array<{ code?: number; message: string }>;
}

/** Build the FQDN Cloudflare wants from a spec name that is relative to the connected domain. */
function toFqdn(name: string, domain: string): string {
  return name === "@" ? domain : `${name}.${domain}`;
}

/** Map a pure {@link DnsRecordSpec} to the Cloudflare create/update payload (CAA uses structured `data`). */
function toCloudflarePayload(spec: DnsRecordSpec, fqdn: string): Record<string, unknown> {
  const base = {
    type: spec.recordType,
    name: fqdn,
    ttl: 1, // 1 = "automatic" in Cloudflare
    comment: `ipop ${spec.purpose} (#264 DNS automation)`,
  };
  if (spec.recordType === "CAA") {
    return { ...base, data: parseCaa(spec.value) };
  }
  if (spec.recordType === "MX") {
    const { priority, host } = parseMx(spec.value);
    return { ...base, content: host, priority };
  }
  return { ...base, content: spec.value };
}

/** Parse `0 issue "letsencrypt.org"` → Cloudflare CAA `data`. */
function parseCaa(value: string): { flags: number; tag: string; value: string } {
  const m = value.match(/^(\d+)\s+(\w+)\s+"?([^"]+)"?$/);
  if (!m || !m[1] || !m[2] || !m[3]) return { flags: 0, tag: "issue", value: value.replace(/"/g, "") };
  return { flags: Number(m[1]), tag: m[2], value: m[3] };
}

/** Parse `10 mail.example.com` → `{priority, host}` (defensive — builders don't emit MX today). */
function parseMx(value: string): { priority: number; host: string } {
  const m = value.match(/^(\d+)\s+(.+)$/);
  return m && m[1] && m[2] ? { priority: Number(m[1]), host: m[2] } : { priority: 10, host: value };
}

/** Does a Cloudflare record match what we planned? Normalizes TXT quoting, CNAME trailing dots, CAA data. */
function recordMatches(spec: DnsRecordSpec, found: CloudflareRecord): boolean {
  if (spec.recordType === "CAA") {
    const want = parseCaa(spec.value);
    const data = (found.data ?? {}) as { tag?: string; value?: string };
    return (
      (data.tag ?? "") === want.tag &&
      String(data.value ?? "").replace(/"/g, "") === want.value
    );
  }
  const want = normalize(spec.value);
  return normalize(found.content ?? "") === want;
}

function normalize(value: string): string {
  return value.trim().replace(/^"|"$/g, "").replace(/\.$/, "").toLowerCase();
}

function receipt(
  spec: DnsRecordSpec,
  status: DnsReceiptResult["status"],
  detail: Record<string, unknown>,
): DnsReceiptResult {
  return {
    recordType: spec.recordType,
    name: spec.name,
    value: spec.value,
    purpose: spec.purpose,
    status,
    detail,
  };
}

function errMsg(err: unknown): string {
  return truncate(err instanceof Error ? err.message : String(err));
}

/** Bound any registrar-sourced string before it lands in a receipt (injection-safety + tidy receipts). */
function truncate(s: string, max = 280): string {
  const clean = Array.from(s).filter((c) => c.charCodeAt(0) >= 32).join("").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
