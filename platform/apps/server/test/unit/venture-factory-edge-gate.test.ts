import { describe, it, expect } from "vitest";
import {
  decideEdgeGate,
  decideFactoryAdmission,
  type EdgeGateInput,
  type FactoryAdmissionInput,
} from "../../src/venture-factory/edge-gate.js";
import type { EdgeClaim } from "../../src/venture-factory/types.js";

/** A fully-qualifying distribution edge: real class, falsifiable, externally evidenced. */
function claim(over: Partial<EdgeClaim> = {}): EdgeClaim {
  return {
    kind: "distribution",
    statement: "an owned 50k-subscriber newsletter in this niche",
    falsifiableTest: "if blended CAC from the list exceeds $5 the distribution edge is false",
    evidence: [
      { source: "convertkit-export", external: true, ownerAttested: false, detail: "50,123 confirmed subs" },
    ],
    ...over,
  };
}

describe("decideEdgeGate (premortem FM#1 — no edge, no launch)", () => {
  it("QUALIFIES a falsifiable, externally-evidenced edge", () => {
    const v = decideEdgeGate({ claims: [claim()] });
    expect(v.status).toBe("qualified");
    expect(v.edgeClasses).toEqual(["distribution"]);
    expect(v.qualifyingClaims).toHaveLength(1);
  });

  it("QUALIFIES an owner-attested secret (legitimate non-external provenance, #100)", () => {
    const v = decideEdgeGate({
      claims: [
        claim({
          kind: "data",
          evidence: [
            { source: "owner", external: false, ownerAttested: true, detail: "5 years of proprietary labelled data" },
          ],
        }),
      ],
    });
    expect(v.status).toBe("qualified");
    expect(v.edgeClasses).toEqual(["data"]);
  });

  it("REJECTS when there are no claims at all", () => {
    const v = decideEdgeGate({ claims: [] });
    expect(v.status).toBe("rejected");
    expect(v.reasons).toEqual(["no edge claims provided"]);
  });

  it("REJECTS an unfalsifiable edge (no disproof test) — a hope, not an edge", () => {
    const v = decideEdgeGate({ claims: [claim({ falsifiableTest: "   " })] });
    expect(v.status).toBe("rejected");
    expect(v.reasons[0]).toMatch(/falsifiable/);
  });

  it("REJECTS an edge with no cited evidence", () => {
    const v = decideEdgeGate({ claims: [claim({ evidence: [] })] });
    expect(v.status).toBe("rejected");
    expect(v.reasons[0]).toMatch(/no cited evidence/);
  });

  it("REJECTS self-asserted-only evidence (premortem FM#2 — 'we think competitors can't')", () => {
    const v = decideEdgeGate({
      claims: [
        claim({
          evidence: [
            { source: "team-belief", external: false, ownerAttested: false, detail: "we feel this is hard to copy" },
          ],
        }),
      ],
    });
    expect(v.status).toBe("rejected");
    expect(v.reasons[0]).toMatch(/self-asserted/);
  });

  it("REJECTS an empty statement and a non-edge class", () => {
    expect(decideEdgeGate({ claims: [claim({ statement: "  " })] }).status).toBe("rejected");
    // a class outside the three real edges (e.g. "execution") — cast through unknown for the test.
    const bogus = claim({ kind: "execution" as unknown as EdgeClaim["kind"] });
    const v = decideEdgeGate({ claims: [bogus] });
    expect(v.status).toBe("rejected");
    expect(v.reasons[0]).toMatch(/not a real edge class/);
  });

  it("dedupes edge classes and keeps only qualifying claims when mixed", () => {
    const input: EdgeGateInput = {
      claims: [
        claim({ kind: "distribution" }),
        claim({ kind: "distribution" }), // duplicate class
        claim({ kind: "relationship", evidence: [] }), // rejected
      ],
    };
    const v = decideEdgeGate(input);
    expect(v.status).toBe("qualified");
    expect(v.edgeClasses).toEqual(["distribution"]);
    expect(v.qualifyingClaims).toHaveLength(2);
    expect(v.reasons.some((r) => r.includes("relationship"))).toBe(false); // reasons only list failures when rejected
  });
});

describe("decideFactoryAdmission (premortem FM#1 — make ONE profitable before scaling)", () => {
  function input(over: Partial<FactoryAdmissionInput> = {}): FactoryAdmissionInput {
    return {
      activeVentures: 0,
      profitableVentures: 0,
      maxConcurrentVentures: 3,
      requireProfitableBeforeScale: true,
      ...over,
    };
  }

  it("admits the very first venture (nothing active yet)", () => {
    expect(decideFactoryAdmission(input()).allowed).toBe(true);
  });

  it("BARS a second venture while the first is not yet externally profitable", () => {
    const d = decideFactoryAdmission(input({ activeVentures: 1, profitableVentures: 0 }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/profitable before scaling/);
  });

  it("admits a second venture once one is externally profitable", () => {
    expect(
      decideFactoryAdmission(input({ activeVentures: 1, profitableVentures: 1 })).allowed,
    ).toBe(true);
  });

  it("still enforces the hard concurrency cap even when profitable", () => {
    const d = decideFactoryAdmission(input({ activeVentures: 3, profitableVentures: 2, maxConcurrentVentures: 3 }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/concurrency cap/);
  });

  it("with the gate disabled, only the concurrency cap applies", () => {
    expect(
      decideFactoryAdmission(input({ activeVentures: 1, profitableVentures: 0, requireProfitableBeforeScale: false })).allowed,
    ).toBe(true);
  });
});
