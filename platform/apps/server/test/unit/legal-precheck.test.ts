import { describe, it, expect } from "vitest";
import {
  assessTrademark,
  checkDomain,
  deterministicNamingPrecheck,
} from "../../src/legal/precheck.js";
import { assessRegulated, decideNamingDisposition } from "../../src/legal/regulated.js";

describe("naming pre-check (#196 criterion 3)", () => {
  it("flags a name containing a well-known mark as high trademark risk", () => {
    expect(assessTrademark("GoogleCloneAI").risk).toBe("high");
    expect(assessTrademark("MyStripeTool").risk).toBe("high");
  });

  it("flags a short generic word as medium risk", () => {
    expect(assessTrademark("box").risk).toBe("medium");
  });

  it("treats a distinctive coined name as low risk", () => {
    expect(assessTrademark("Quibbleflux").risk).toBe("low");
  });

  it("is deterministic — same name/domain ⇒ same verdict", async () => {
    const a = await deterministicNamingPrecheck.check({ name: "Quibbleflux", domains: ["quibbleflux.com", "quibbleflux.io"] });
    const b = await deterministicNamingPrecheck.check({ name: "Quibbleflux", domains: ["quibbleflux.com", "quibbleflux.io"] });
    expect(a).toEqual(b);
  });

  it("never reports a famous-mark domain as available", () => {
    expect(checkDomain("google.com").available).toBe(false);
  });

  it("clearToProceed is false when trademark risk is high", async () => {
    const r = await deterministicNamingPrecheck.check({ name: "AppleThing", domains: ["applething.com"] });
    expect(r.trademarkRisk).toBe("high");
    expect(r.clearToProceed).toBe(false);
  });
});

describe("regulated-industry hard-stop (#196 criterion 5)", () => {
  it("flags a health venture as regulated → hard_stop", () => {
    const a = assessRegulated({ industry: "telehealth platform", dataCollected: ["email"] });
    expect(a.regulated).toBe(true);
    expect(a.category).toBe("health");
    expect(a.disposition).toBe("hard_stop");
  });

  it("flags sensitive data alone (no industry label) as regulated", () => {
    const a = assessRegulated({ industry: null, dataCollected: ["email", "health"] });
    expect(a.regulated).toBe(true);
  });

  it("treats a plain SaaS venture as not regulated → proceed", () => {
    const a = assessRegulated({ industry: "project management saas", dataCollected: ["email", "name"] });
    expect(a.regulated).toBe(false);
    expect(a.disposition).toBe("proceed");
  });

  it("combines precheck + regulated into a disposition (regulated wins → hard_stop)", () => {
    const precheck = { name: "Clearname", trademarkRisk: "low" as const, trademarkNotes: [], domainCollisions: [{ domain: "clearname.com", available: true }], clearToProceed: true };
    const reg = assessRegulated({ industry: "lending", dataCollected: [] });
    expect(decideNamingDisposition(precheck, reg).disposition).toBe("hard_stop");
  });

  it("routes a clean-but-risky name to owner_review", () => {
    const precheck = { name: "box", trademarkRisk: "medium" as const, trademarkNotes: ["generic"], domainCollisions: [{ domain: "box.com", available: false }], clearToProceed: false };
    const reg = assessRegulated({ industry: "saas", dataCollected: [] });
    expect(decideNamingDisposition(precheck, reg).disposition).toBe("owner_review");
  });

  it("lets a clear, non-regulated, low-risk name proceed", () => {
    const precheck = { name: "Quibbleflux", trademarkRisk: "low" as const, trademarkNotes: [], domainCollisions: [{ domain: "quibbleflux.com", available: true }], clearToProceed: true };
    const reg = assessRegulated({ industry: "saas", dataCollected: ["email"] });
    expect(decideNamingDisposition(precheck, reg).disposition).toBe("proceed");
  });
});
