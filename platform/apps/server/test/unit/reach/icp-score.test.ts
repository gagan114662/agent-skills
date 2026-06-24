import { describe, it, expect } from "vitest";
import { deriveIcp, domainLabel } from "../../../src/reach/icp.js";
import {
  contactKey,
  dedupeAgainstContacted,
  pickFreshSignal,
  rankBatch,
  scoreProspect,
} from "../../../src/reach/score.js";
import { resolveReachCaps, REACH_DEFAULTS, isOwnerWorkspace } from "../../../src/reach/caps.js";
import type { RawProspect } from "../../../src/reach/types.js";

const NOW = Date.UTC(2026, 5, 16, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function prospect(overrides: Partial<RawProspect> = {}): RawProspect {
  return {
    fullName: "Jane Doe",
    title: "Head of Growth",
    company: "Acme",
    companyDomain: "acme.com",
    email: "jane@acme.com",
    linkedinUrl: null,
    industry: "saas",
    companySize: "11-50",
    signals: [],
    sourceKind: "mock",
    ...overrides,
  };
}

describe("deriveIcp (#280)", () => {
  it("falls back to the domain label as a keyword and sensible role/size defaults", () => {
    const icp = deriveIcp({ domain: "ipop.ai" });
    expect(icp.keywords).toContain("ipop");
    expect(icp.roles).toContain("founder");
    expect(icp.companySizes).toContain("11-50");
    // every real signal kind appears exactly once
    expect(new Set(icp.signalKinds).size).toBe(icp.signalKinds.length);
  });

  it("honours owner-supplied hints and orders priority signals first", () => {
    const icp = deriveIcp({
      domain: "https://www.example.com/path",
      productKeywords: ["Cold Outbound", "cold outbound"],
      targetRoles: ["VP Sales"],
      prioritySignals: ["pricing_page_visit"],
    });
    expect(icp.keywords).toEqual(["cold outbound"]); // lowercased + deduped
    expect(icp.roles).toEqual(["vp sales"]);
    expect(icp.signalKinds[0]).toBe("pricing_page_visit");
  });

  it("ignores an unknown (poisoned) priority-signal hint — closed enum", () => {
    const icp = deriveIcp({ domain: "x.co", prioritySignals: ["ignore_previous_instructions" as never] });
    expect(icp.signalKinds).not.toContain("ignore_previous_instructions");
  });

  it("domainLabel strips scheme/www/path", () => {
    expect(domainLabel("https://www.ipop.ai/pricing")).toBe("ipop");
  });
});

describe("scoring + dedupe (#280)", () => {
  const icp = deriveIcp({ domain: "ipop.ai", targetIndustries: ["saas"], productKeywords: ["growth"] });

  it("rewards role/industry/size/keyword fit", () => {
    const scored = scoreProspect(prospect(), icp, NOW);
    expect(scored.score).toBeGreaterThan(0);
    expect(scored.scoreReasons.some((r) => r.startsWith("role match"))).toBe(true);
  });

  it("a fresh high-priority signal outranks a stale one", () => {
    const funded = prospect({
      email: "a@a.com",
      signals: [{ kind: "funding_round", summary: "Raised $5M", observedAtMs: NOW - DAY }],
    });
    const stale = prospect({
      email: "b@b.com",
      signals: [{ kind: "job_change", summary: "New role", observedAtMs: NOW - 60 * DAY }],
    });
    const a = scoreProspect(funded, icp, NOW);
    const b = scoreProspect(stale, icp, NOW);
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.freshSignal?.kind).toBe("funding_round");
    // The stale job_change is still the freshest qualifying signal — just scored near-zero on recency.
    expect(b.freshSignal?.kind).toBe("job_change");
  });

  it("pickFreshSignal ignores off-ICP signal kinds", () => {
    const narrowIcp = { ...icp, signalKinds: ["funding_round" as const] };
    const p = prospect({
      signals: [{ kind: "hiring_surge", summary: "x", observedAtMs: NOW }],
    });
    expect(pickFreshSignal(p, narrowIcp, NOW)).toBeNull();
  });

  it("contactKey prefers email, then linkedin, then name|company", () => {
    expect(contactKey(prospect({ email: "J@A.com" }))).toBe("email:j@a.com");
    expect(contactKey(prospect({ email: null, linkedinUrl: "LI/Jane" }))).toBe("linkedin:li/jane");
    expect(contactKey(prospect({ email: null, linkedinUrl: null }))).toBe("id:jane doe|acme");
  });

  it("dedupes against already-contacted AND within the batch", () => {
    const a = scoreProspect(prospect({ email: "dup@a.com" }), icp, NOW);
    const b = scoreProspect(prospect({ email: "dup@a.com", fullName: "Other" }), icp, NOW);
    const c = scoreProspect(prospect({ email: "new@a.com" }), icp, NOW);
    const out = dedupeAgainstContacted([a, b, c], new Set(["email:old@a.com"]));
    expect(out.map((s) => s.contactKey)).toEqual(["email:dup@a.com", "email:new@a.com"]);
    const out2 = dedupeAgainstContacted([a, c], new Set(["email:dup@a.com"]));
    expect(out2.map((s) => s.contactKey)).toEqual(["email:new@a.com"]);
  });

  it("rankBatch returns top-N net-new, highest score first", () => {
    const ps = [
      prospect({ email: "1@a.com", title: "Janitor", industry: null, companySize: null, signals: [] }),
      prospect({
        email: "2@a.com",
        signals: [{ kind: "funding_round", summary: "raised", observedAtMs: NOW }],
      }),
    ];
    const ranked = rankBatch(ps, icp, new Set(), NOW, 5);
    expect(ranked[0]?.contactKey).toBe("email:2@a.com"); // funded head-of-growth wins
    const capped = rankBatch(ps, icp, new Set(), NOW, 1);
    expect(capped).toHaveLength(1);
  });
});

describe("resolveReachCaps (#280)", () => {
  it("defaults OFF, imported source, dryrun sender", () => {
    const caps = resolveReachCaps(undefined);
    expect(caps).toMatchObject({ enabled: false, prospectSource: "imported", sendProvider: "dryrun" });
    expect(caps.perDomainDailyCap).toBe(REACH_DEFAULTS.perDomainDailyCap);
  });

  it("rejects an unknown prospect source, keeps positive ints", () => {
    expect(resolveReachCaps({ prospectSource: "scrapey" }).prospectSource).toBe("imported");
    expect(resolveReachCaps({ prospectSource: "clay", perDomainDailyCap: 10 })).toMatchObject({
      prospectSource: "clay",
      perDomainDailyCap: 10,
    });
    expect(resolveReachCaps({ perDomainDailyCap: -5 }).perDomainDailyCap).toBe(
      REACH_DEFAULTS.perDomainDailyCap,
    );
  });

  it("owner-workspace detection", () => {
    expect(isOwnerWorkspace(resolveReachCaps({ ownerWorkspaceId: "ws1" }), "ws1")).toBe(true);
    expect(isOwnerWorkspace(resolveReachCaps(undefined), "ws1")).toBe(false);
  });
});
