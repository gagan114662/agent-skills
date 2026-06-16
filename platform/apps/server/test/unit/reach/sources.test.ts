import { describe, it, expect } from "vitest";
import { createMockProspectSource } from "../../../src/reach/sources/mock.js";
import { createClaySource } from "../../../src/reach/sources/clay.js";
import { createProspectSource } from "../../../src/reach/sources/index.js";
import { ProspectSourceUnavailableError } from "../../../src/reach/prospect-source.js";
import type { HttpFetch, HttpResponse } from "../../../src/reach/sources/http.js";
import { deriveIcp } from "../../../src/reach/icp.js";

const NOW = Date.UTC(2026, 5, 16, 12, 0, 0);
const icp = deriveIcp({ domain: "ipop.ai", targetIndustries: ["saas"], productKeywords: ["growth"] });

function okJson(body: unknown): HttpResponse {
  return { ok: true, status: 200, json: async () => body };
}

describe("MockProspectSource (#280)", () => {
  it("is free and deterministic", async () => {
    const src = createMockProspectSource({ now: () => NOW });
    expect(src.paid).toBe(false);
    expect(src.estimateCostCents(100)).toBe(0);
    const a = await src.search({ icp, limit: 5, excludeKeys: new Set() });
    const b = await src.search({ icp, limit: 5, excludeKeys: new Set() });
    expect(a.prospects).toHaveLength(5);
    expect(a.creditsCents).toBe(0);
    expect(a.prospects.map((p) => p.email)).toEqual(b.prospects.map((p) => p.email));
    // every prospect carries a live ICP signal
    expect(a.prospects.every((p) => p.signals.length > 0)).toBe(true);
  });

  it("respects excludeKeys (never re-surfaces a contacted prospect)", async () => {
    const src = createMockProspectSource({ now: () => NOW });
    const first = await src.search({ icp, limit: 3, excludeKeys: new Set() });
    const exclude = new Set(first.prospects.map((p) => `email:${p.email}`));
    const second = await src.search({ icp, limit: 3, excludeKeys: exclude });
    for (const p of second.prospects) expect(exclude.has(`email:${p.email}`)).toBe(false);
  });
});

describe("paid HTTP source — Clay (#280)", () => {
  const clay = (httpFetch: HttpFetch, loadApiKey: () => Promise<string | null>) =>
    createClaySource({ httpFetch, loadApiKey, now: () => NOW });

  it("is paid and estimates cost from the limit", () => {
    const src = clay(async () => okJson({}), async () => "key");
    expect(src.paid).toBe(true);
    expect(src.estimateCostCents(10)).toBe(50); // 5c each
  });

  it("throws ProspectSourceUnavailable when no API key is in the vault (→ service queues, never fakes)", async () => {
    const src = clay(async () => okJson({}), async () => null);
    await expect(src.search({ icp, limit: 5, excludeKeys: new Set() })).rejects.toBeInstanceOf(
      ProspectSourceUnavailableError,
    );
  });

  it("maps the API response, applies excludeKeys + limit, and only bills for kept prospects", async () => {
    let sentAuth = "";
    const httpFetch: HttpFetch = async (_url, init) => {
      sentAuth = init.headers.authorization ?? "";
      return okJson({
        data: [
          { fullName: "Ann Lee", company: "Acme", email: "ann@acme.com", title: "Head of Growth", signals: [{ kind: "funding_round", summary: "raised" }] },
          { fullName: "Bo Kim", company: "Beta", email: "bo@beta.com", title: "Founder" },
          { fullName: "No Reach", company: "Ghost" }, // dropped: no email/linkedin
        ],
      });
    };
    const src = clay(httpFetch, async () => "secret-key");
    const res = await src.search({ icp, limit: 1, excludeKeys: new Set(["email:bo@beta.com"]) });
    expect(sentAuth).toBe("Bearer secret-key"); // key used in header, never logged
    expect(res.prospects).toHaveLength(1);
    expect(res.prospects[0]?.email).toBe("ann@acme.com");
    expect(res.creditsCents).toBe(5); // billed for the one kept
  });

  it("treats a non-OK HTTP status as unavailable", async () => {
    const src = clay(async () => ({ ok: false, status: 429, json: async () => ({}) }), async () => "key");
    await expect(src.search({ icp, limit: 5, excludeKeys: new Set() })).rejects.toBeInstanceOf(
      ProspectSourceUnavailableError,
    );
  });
});

describe("createProspectSource resolver (#280)", () => {
  it("builds the mock source with no creds, and a paid source bound to its vault key", async () => {
    const calls: string[] = [];
    const deps = {
      httpFetch: (async () => okJson({ data: [] })) as HttpFetch,
      loadApiKey: async (serviceKey: string) => {
        calls.push(serviceKey);
        return "k";
      },
      now: () => NOW,
    };
    expect(createProspectSource("mock", deps).paid).toBe(false);
    const clay = createProspectSource("clay", deps);
    expect(clay.kind).toBe("clay");
    await clay.search({ icp, limit: 1, excludeKeys: new Set() });
    expect(calls).toContain("clay"); // resolved its vault service_key
  });
});
