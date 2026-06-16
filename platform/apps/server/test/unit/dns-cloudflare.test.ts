import { describe, it, expect, vi, afterEach } from "vitest";
import { CloudflareDnsProvider } from "../../src/onboarding/dns/cloudflare-provider.js";
import {
  buildSpfRecord,
  buildDkimRecord,
  buildDmarcRecord,
  buildCaaRecord,
  buildGoogleVerificationRecord,
  buildCnameRecord,
} from "../../src/onboarding/dns/records.js";

/**
 * Cloudflare connector (#264). The registrar API is mocked via `vi.stubGlobal("fetch", …)` (the
 * `realworld-site-pr.test.ts` pattern) so CI needs no token and touches no network. We assert the exact
 * REST sequence — zone lookup, create-vs-update, CAA `data` shape — plus that the token rides only the
 * Authorization header (never a log line) and that errors degrade to `failed` receipts, never throws.
 */

const API = "https://api.test/v4";

afterEach(() => vi.unstubAllGlobals());

interface Call {
  url: string;
  method: string;
  body?: Record<string, unknown>;
  auth?: string;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * A mock Cloudflare API. `zones` maps a zone name → zone id; `existing` is the set of FQDN|type keys that
 * already have a record (so we can drive the update path). Records every call for assertions.
 */
function mockCloudflare(opts: {
  zones: Record<string, string>;
  existing?: Record<
    string,
    { id: string; content?: string; data?: Record<string, unknown>; priority?: number }
  >;
}): { calls: Call[]; fetchMock: ReturnType<typeof vi.fn> } {
  const calls: Call[] = [];
  const existing = opts.existing ?? {};
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.Authorization,
    });
    const u = new URL(url);
    // Zone lookup: GET /zones?name=<zone>
    if (u.pathname.endsWith("/zones") && method === "GET") {
      const name = u.searchParams.get("name") ?? "";
      const id = opts.zones[name];
      return jsonRes({ success: true, result: id ? [{ id, name }] : [] });
    }
    // List records: GET /zones/:zone/dns_records?type&name
    if (u.pathname.endsWith("/dns_records") && method === "GET") {
      const type = u.searchParams.get("type") ?? "";
      const name = u.searchParams.get("name") ?? "";
      const hit = existing[`${name}|${type}`];
      return jsonRes({
        success: true,
        result: hit
          ? [{ id: hit.id, type, name, content: hit.content, data: hit.data, priority: hit.priority }]
          : [],
      });
    }
    // Create: POST /zones/:zone/dns_records
    if (u.pathname.endsWith("/dns_records") && method === "POST") {
      return jsonRes({ success: true, result: { id: "new_rec_id" } }, 201);
    }
    // Update: PUT /zones/:zone/dns_records/:id
    if (u.pathname.includes("/dns_records/") && method === "PUT") {
      return jsonRes({ success: true, result: { id: u.pathname.split("/").pop() } });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

describe("CloudflareDnsProvider.configure (#264) — REST sequence", () => {
  it("resolves the zone, then CREATEs each record that does not yet exist", async () => {
    const { calls } = mockCloudflare({ zones: { "example.com": "zone123" } });
    const provider = new CloudflareDnsProvider({ token: "cf_tok", apiBase: API });
    const records = [buildGoogleVerificationRecord("gtoken"), buildSpfRecord({ includes: ["sendgrid.net"] })];

    const out = await provider.configure({ domain: "example.com", records });

    expect(out.provider).toBe("cloudflare");
    expect(out.receipts.every((r) => r.status === "configured")).toBe(true);
    expect(out.receipts[0]?.detail).toMatchObject({ action: "created", recordId: "new_rec_id", zoneId: "zone123" });

    // zone lookup first, then a GET (does it exist?) + POST (create) per record.
    const seq = calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`);
    expect(seq[0]).toBe("GET /v4/zones?name=example.com");
    expect(seq).toContain("POST /v4/zones/zone123/dns_records");
    // The created TXT carried the planned content.
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({ type: "TXT", name: "example.com", content: "google-site-verification=gtoken" });
  });

  it("UPDATEs (PUT) a record that already exists instead of creating a duplicate", async () => {
    const { calls } = mockCloudflare({
      zones: { "example.com": "zone123" },
      existing: { "example.com|TXT": { id: "rec_existing", content: "old" } },
    });
    const provider = new CloudflareDnsProvider({ token: "cf_tok", apiBase: API });
    const out = await provider.configure({
      domain: "example.com",
      records: [buildSpfRecord({ includes: ["sendgrid.net"] })],
    });

    expect(out.receipts[0]?.status).toBe("configured");
    expect(out.receipts[0]?.detail).toMatchObject({ action: "updated", recordId: "rec_existing" });
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/dns_records/rec_existing");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("sends CAA records as Cloudflare structured `data`, not `content`", async () => {
    const { calls } = mockCloudflare({ zones: { "example.com": "zone123" } });
    const provider = new CloudflareDnsProvider({ token: "cf_tok", apiBase: API });
    await provider.configure({ domain: "example.com", records: [buildCaaRecord()] });

    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({ type: "CAA", data: { flags: 0, tag: "issue", value: "letsencrypt.org" } });
    expect(post?.body).not.toHaveProperty("content");
  });

  it("sends MX records with the preference in Cloudflare's `priority` field, host in `content`", async () => {
    const { calls } = mockCloudflare({ zones: { "example.com": "zone123" } });
    const provider = new CloudflareDnsProvider({ token: "cf_tok", apiBase: API });
    const mx = { recordType: "MX" as const, name: "@", value: "10 mail.example.com", purpose: "dns" as const };
    const out = await provider.configure({ domain: "example.com", records: [mx] });

    expect(out.receipts[0]?.status).toBe("configured");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({ type: "MX", name: "example.com", content: "mail.example.com", priority: 10 });
    expect(post?.body?.content).not.toBe("10 mail.example.com"); // preference is NOT smuggled into content
  });

  it("walks sub-domain labels up to the registrable apex to find the zone", async () => {
    const { calls } = mockCloudflare({ zones: { "example.com": "zoneAPEX" } });
    const provider = new CloudflareDnsProvider({ token: "cf_tok", apiBase: API });
    const out = await provider.configure({
      domain: "blog.example.com",
      records: [buildCnameRecord("cname.vercel-dns.com")],
    });

    expect(out.receipts[0]?.status).toBe("configured");
    const zoneLookups = calls.filter((c) => new URL(c.url).pathname.endsWith("/zones")).map((c) => new URL(c.url).searchParams.get("name"));
    expect(zoneLookups).toEqual(["blog.example.com", "example.com"]); // tried specific, then apex
    // CNAME FQDN is the connected host, not bare apex.
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ name: "blog.example.com" });
  });

  it("carries the token in the Authorization header and never in a log line", async () => {
    const { calls } = mockCloudflare({ zones: { "example.com": "zone123" } });
    const lines: string[] = [];
    const provider = new CloudflareDnsProvider({ token: "super_secret_tok", apiBase: API });
    await provider.configure({
      domain: "example.com",
      records: [buildDkimRecord("s1", "PUBKEY")],
      onLog: (l) => lines.push(l),
    });
    expect(calls.every((c) => c.auth === "Bearer super_secret_tok")).toBe(true);
    expect(lines.join("\n")).not.toContain("super_secret_tok");
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("CloudflareDnsProvider.verify (#264)", () => {
  it("marks a record verified when the published content matches (TXT quoting normalized)", async () => {
    mockCloudflare({
      zones: { "example.com": "zone123" },
      existing: { 'example.com|TXT': { id: "r1", content: '"v=spf1 include:sendgrid.net ~all"' } },
    });
    const provider = new CloudflareDnsProvider({ token: "cf_tok", apiBase: API });
    const out = await provider.verify({
      domain: "example.com",
      records: [buildSpfRecord({ includes: ["sendgrid.net"] })],
    });
    expect(out.receipts[0]?.status).toBe("verified");
    expect(out.receipts[0]?.detail).toMatchObject({ recordId: "r1" });
  });

  it("verifies an MX record by comparing host content AND priority", async () => {
    mockCloudflare({
      zones: { "example.com": "zone123" },
      existing: { "example.com|MX": { id: "mx1", content: "mail.example.com", priority: 10 } },
    });
    const provider = new CloudflareDnsProvider({ token: "cf_tok", apiBase: API });
    const mx = { recordType: "MX" as const, name: "@", value: "10 mail.example.com", purpose: "dns" as const };
    const out = await provider.verify({ domain: "example.com", records: [mx] });
    expect(out.receipts[0]?.status).toBe("verified");
  });

  it("fails MX verification when the host matches but the priority differs", async () => {
    mockCloudflare({
      zones: { "example.com": "zone123" },
      existing: { "example.com|MX": { id: "mx1", content: "mail.example.com", priority: 20 } },
    });
    const provider = new CloudflareDnsProvider({ token: "cf_tok", apiBase: API });
    const mx = { recordType: "MX" as const, name: "@", value: "10 mail.example.com", purpose: "dns" as const };
    const out = await provider.verify({ domain: "example.com", records: [mx] });
    expect(out.receipts[0]?.status).toBe("failed");
    expect(out.receipts[0]?.detail).toMatchObject({ reason: "value mismatch" });
  });

  it("fails verification when the record is missing or the value differs", async () => {
    mockCloudflare({
      zones: { "example.com": "zone123" },
      existing: { "_dmarc.example.com|TXT": { id: "r2", content: "v=DMARC1; p=reject" } },
    });
    const provider = new CloudflareDnsProvider({ token: "cf_tok", apiBase: API });
    const out = await provider.verify({
      domain: "example.com",
      records: [buildDmarcRecord({ policy: "none" }), buildGoogleVerificationRecord("missing")],
    });
    expect(out.receipts[0]?.status).toBe("failed"); // value mismatch (reject vs none)
    expect(out.receipts[0]?.detail).toMatchObject({ reason: "value mismatch" });
    expect(out.receipts[1]?.status).toBe("failed"); // not found
    expect(out.receipts[1]?.detail).toMatchObject({ reason: "record not found" });
  });
});

describe("CloudflareDnsProvider — failure handling (never throws)", () => {
  it("marks every record failed (no fetch) when constructed without a token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new CloudflareDnsProvider({ token: "", apiBase: API });
    const out = await provider.configure({ domain: "example.com", records: [buildSpfRecord()] });
    expect(out.receipts[0]?.status).toBe("failed");
    expect(String(out.receipts[0]?.detail?.error)).toContain("Cloudflare API token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails all records when the zone cannot be resolved", async () => {
    mockCloudflare({ zones: {} }); // no zone for this account
    const provider = new CloudflareDnsProvider({ token: "cf_tok", apiBase: API });
    const out = await provider.configure({ domain: "unknown.com", records: [buildSpfRecord()] });
    expect(out.receipts.every((r) => r.status === "failed")).toBe(true);
    expect(String(out.receipts[0]?.detail?.error)).toContain("no Cloudflare zone");
  });

  it("turns a Cloudflare API error into a failed receipt, not a throw", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (new URL(url).pathname.endsWith("/zones")) {
        return jsonRes({ success: true, result: [{ id: "zone123", name: "example.com" }] });
      }
      // record list ok (none), then the create fails with an API error envelope
      if (new URL(url).searchParams.has("type")) return jsonRes({ success: true, result: [] });
      return jsonRes({ success: false, errors: [{ code: 9109, message: "Invalid access token" }] }, 403);
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new CloudflareDnsProvider({ token: "cf_tok", apiBase: API });
    const out = await provider.configure({ domain: "example.com", records: [buildSpfRecord()] });
    expect(out.receipts[0]?.status).toBe("failed");
    expect(String(out.receipts[0]?.detail?.error)).toContain("Invalid access token");
  });
});
