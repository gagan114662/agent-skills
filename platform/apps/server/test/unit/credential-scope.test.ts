import { describe, it, expect } from "vitest";
import {
  allowedKeysForAgent,
  filterSecrets,
  resolveCredentialMatrix,
  type CredentialMatrix,
} from "../../src/runtime/credential-scope.js";

// The model-auth keys (#68) that must never be scoped away — a scoped agent still runs the model.
const ALWAYS_KEEP = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

const MATRIX: CredentialMatrix = {
  enabled: true,
  purposes: {
    crawl: ["CRAWL_TOKEN", "SCRAPER_API_KEY"],
    email: ["POSTMARK_TOKEN"],
    payments: ["STRIPE_SECRET_KEY"],
  },
  agents: {
    scout: ["crawl"],
    postmark: ["email"],
    treasurer: ["payments", "email"],
  },
};

const SECRETS = {
  CRAWL_TOKEN: "c1",
  SCRAPER_API_KEY: "s1",
  POSTMARK_TOKEN: "p1",
  STRIPE_SECRET_KEY: "k1",
  ANTHROPIC_API_KEY: "model",
};

describe("credential-scope (#151 — per-agent scoped credentials)", () => {
  it("scout may read crawl tokens but never the Stripe key", () => {
    const allowed = allowedKeysForAgent(MATRIX, "scout");
    expect(allowed).toEqual(expect.arrayContaining(["CRAWL_TOKEN", "SCRAPER_API_KEY"]));
    expect(allowed).not.toContain("STRIPE_SECRET_KEY");
    expect(allowed).not.toContain("POSTMARK_TOKEN");

    const scoped = filterSecrets(SECRETS, allowed, ALWAYS_KEEP);
    expect(scoped).toEqual({ CRAWL_TOKEN: "c1", SCRAPER_API_KEY: "s1", ANTHROPIC_API_KEY: "model" });
  });

  it("postmark gets email creds only", () => {
    const scoped = filterSecrets(SECRETS, allowedKeysForAgent(MATRIX, "postmark"), ALWAYS_KEEP);
    expect(scoped).toEqual({ POSTMARK_TOKEN: "p1", ANTHROPIC_API_KEY: "model" });
  });

  it("unions keys across an agent's multiple purposes", () => {
    const allowed = allowedKeysForAgent(MATRIX, "treasurer");
    expect(allowed).toEqual(expect.arrayContaining(["STRIPE_SECRET_KEY", "POSTMARK_TOKEN"]));
  });

  it("narrows to a single purpose when one is given", () => {
    const allowed = allowedKeysForAgent(MATRIX, "treasurer", "email");
    expect(allowed).toEqual(["POSTMARK_TOKEN"]);
  });

  it("denies-by-default: an unknown agent gets only the always-keep model keys", () => {
    const allowed = allowedKeysForAgent(MATRIX, "stranger");
    expect(allowed).toEqual([]);
    const scoped = filterSecrets(SECRETS, allowed, ALWAYS_KEEP);
    expect(scoped).toEqual({ ANTHROPIC_API_KEY: "model" });
  });

  it("the model-auth keys are NEVER scoped away even for a denied agent", () => {
    const scoped = filterSecrets(SECRETS, [], ALWAYS_KEEP);
    expect(scoped.ANTHROPIC_API_KEY).toBe("model");
  });

  it("default-OFF: a disabled matrix returns null (passthrough) and keeps every secret byte-for-byte", () => {
    const off = resolveCredentialMatrix({ enabled: false });
    expect(allowedKeysForAgent(off, "scout")).toBeNull();
    expect(filterSecrets(SECRETS, null, ALWAYS_KEEP)).toEqual(SECRETS);
  });

  it("an absent config block resolves to OFF", () => {
    expect(resolveCredentialMatrix(undefined)).toEqual({ enabled: false, purposes: {}, agents: {} });
  });

  it("filterSecrets never mutates its inputs", () => {
    const frozen = Object.freeze({ ...SECRETS });
    filterSecrets(frozen, ["CRAWL_TOKEN"], ALWAYS_KEEP);
    expect(frozen).toEqual(SECRETS);
  });
});
