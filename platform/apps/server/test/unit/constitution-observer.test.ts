import { describe, it, expect, afterEach } from "vitest";
import { createConstitutionObserver } from "../../src/observability/constitution-log.js";
import type { ConstitutionViolation } from "../../src/constitution/types.js";

const violation: ConstitutionViolation = {
  article: "I",
  code: "love_paradigm_unmet",
  severity: "block",
  stage: "FUND",
  message: "test",
};

const obs = (input: Parameters<ReturnType<typeof createConstitutionObserver>["log"]>[0]) => ({
  workspaceId: "ws",
  ideaId: "idea",
  stage: "FUND",
  verdict: "FUND",
  violation,
  ...input,
});

describe("createConstitutionObserver (Braintrust event logger)", () => {
  const prev = process.env.BRAINTRUST_API_KEY;
  afterEach(() => {
    if (prev === undefined) delete process.env.BRAINTRUST_API_KEY;
    else process.env.BRAINTRUST_API_KEY = prev;
  });

  it("is a no-op (never throws, never calls out) when no Braintrust key is set", () => {
    delete process.env.BRAINTRUST_API_KEY;
    const observer = createConstitutionObserver();
    expect(() => observer.log(obs({}))).not.toThrow();
  });

  it("is a no-op under data-privacy mode even with a key (egress gate)", () => {
    process.env.BRAINTRUST_API_KEY = "test-key";
    const observer = createConstitutionObserver({ dataPrivacyMode: true });
    expect(() => observer.log(obs({}))).not.toThrow();
  });
});
