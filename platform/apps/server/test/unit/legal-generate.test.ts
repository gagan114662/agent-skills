import { describe, it, expect } from "vitest";
import {
  composeDocument,
  composePack,
  fingerprintFacts,
  isMaterialChange,
} from "../../src/legal/generate.js";
import { DOCUMENT_DISCLAIMER } from "../../src/legal/disclaimer.js";
import type { VentureLegalFacts } from "../../src/legal/types.js";

const facts: VentureLegalFacts = {
  ventureIdeaId: "v-1",
  jurisdiction: "US-CA",
  dataCollected: ["email", "name", "payment", "analytics"],
  paymentFlows: ["stripe_subscription"],
  industry: "saas",
};

describe("legal document generation (#196 criterion 1)", () => {
  it("composes a ToS + privacy + DPA pack, each with the non-counsel disclaimer", () => {
    const pack = composePack(facts);
    expect(pack.map((d) => d.kind)).toEqual(["tos", "privacy", "dpa"]);
    for (const doc of pack) {
      expect(doc.body).toContain(DOCUMENT_DISCLAIMER);
      expect(doc.body.toLowerCase()).toContain("not legal advice");
      expect(doc.version).toMatch(/^[0-9a-f]{12}$/);
      expect(doc.contentHash).toBe(doc.version);
    }
  });

  it("renders facts into the documents (jurisdiction, data, payments)", () => {
    const tos = composeDocument("tos", facts);
    const privacy = composeDocument("privacy", facts);
    const dpa = composeDocument("dpa", facts);
    expect(tos.body).toContain("US-CA");
    expect(tos.body.toLowerCase()).toContain("renew automatically"); // subscription payment flow
    expect(privacy.body.toLowerCase()).toContain("email address");
    expect(privacy.body.toLowerCase()).toContain("usage and analytics data");
    expect(privacy.body.toLowerCase()).toContain("unsubscribe"); // CAN-SPAM marketing section
    expect(dpa.body).toContain("Data Processing Agreement");
    expect(dpa.body.toLowerCase()).toContain("data-subject requests");
    expect(dpa.body).toContain("support@ipop.ai");
  });

  it("is deterministic — same facts produce a byte-identical body + version", () => {
    expect(composeDocument("tos", facts)).toEqual(composeDocument("tos", { ...facts }));
  });

  it("fingerprints facts order-independently (reordered tokens ⇒ same hash)", () => {
    const reordered: VentureLegalFacts = {
      ...facts,
      dataCollected: ["analytics", "payment", "name", "email"],
    };
    expect(fingerprintFacts(reordered)).toBe(fingerprintFacts(facts));
    expect(isMaterialChange(fingerprintFacts(facts), reordered)).toBe(false);
  });

  it("detects a material change when the facts change", () => {
    const published = composeDocument("privacy", facts);
    const changed: VentureLegalFacts = { ...facts, jurisdiction: "EU", dataCollected: [...facts.dataCollected, "location"] };
    expect(isMaterialChange(published.sourceFactsHash, changed)).toBe(true);
    expect(composeDocument("privacy", changed).version).not.toBe(published.version);
  });

  it("handles a venture with no payment flow and minimal data", () => {
    const minimal: VentureLegalFacts = {
      ventureIdeaId: "v-2",
      jurisdiction: "",
      dataCollected: [],
      paymentFlows: ["none"],
      industry: null,
    };
    const pack = composePack(minimal);
    expect(pack[0].body).toContain("the United States"); // default jurisdiction
    expect(pack[1].body.toLowerCase()).toContain("the information you provide to us"); // default data
  });
});
