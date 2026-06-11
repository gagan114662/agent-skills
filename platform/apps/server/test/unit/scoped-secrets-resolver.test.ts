import { describe, it, expect } from "vitest";
import {
  ScopedSecretsResolver,
  StaticSecretsResolver,
  type SecretsResolver,
} from "../../src/runtime/secrets-resolver.js";
import { resolveCredentialMatrix, type CredentialMatrix } from "../../src/runtime/credential-scope.js";

const SECRETS = {
  CRAWL_TOKEN: "c1",
  POSTMARK_TOKEN: "p1",
  STRIPE_SECRET_KEY: "k1",
  CLAUDE_CODE_OAUTH_TOKEN: "model",
};

const inner: SecretsResolver = new StaticSecretsResolver(SECRETS);

const ENABLED: CredentialMatrix = {
  enabled: true,
  purposes: { crawl: ["CRAWL_TOKEN"], email: ["POSTMARK_TOKEN"], payments: ["STRIPE_SECRET_KEY"] },
  agents: { scout: ["crawl"], postmark: ["email"] },
};

// A fake personas lookup: member id "m-scout" → "scout", etc.
const NAMES: Record<string, string> = { "m-scout": "scout", "m-postmark": "postmark" };
const lookupAgentName = (_ws: string, mid: string) => Promise.resolve(NAMES[mid] ?? null);

describe("ScopedSecretsResolver (#151 — per-agent scoping decorator)", () => {
  it("default-OFF (disabled matrix): passes the inner secrets through byte-for-byte", async () => {
    const r = new ScopedSecretsResolver(inner, {
      loadMatrix: () => resolveCredentialMatrix({ enabled: false }),
      lookupAgentName,
    });
    expect(await r.resolve("ws", { agentMemberId: "m-scout" })).toEqual(SECRETS);
  });

  it("enabled + scout: filters to crawl keys + the always-kept model token", async () => {
    const r = new ScopedSecretsResolver(inner, { loadMatrix: () => ENABLED, lookupAgentName });
    expect(await r.resolve("ws", { agentMemberId: "m-scout" })).toEqual({
      CRAWL_TOKEN: "c1",
      CLAUDE_CODE_OAUTH_TOKEN: "model",
    });
  });

  it("enabled + postmark: email creds only (never Stripe)", async () => {
    const r = new ScopedSecretsResolver(inner, { loadMatrix: () => ENABLED, lookupAgentName });
    const out = await r.resolve("ws", { agentMemberId: "m-postmark" });
    expect(out).toEqual({ POSTMARK_TOKEN: "p1", CLAUDE_CODE_OAUTH_TOKEN: "model" });
    expect(out.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it("enabled + a workspace-only call (no agent): passthrough (callers like billing are never scoped)", async () => {
    const r = new ScopedSecretsResolver(inner, { loadMatrix: () => ENABLED, lookupAgentName });
    expect(await r.resolve("ws")).toEqual(SECRETS);
  });

  it("enabled + unknown agent: deny-by-default keeps only the model token", async () => {
    const r = new ScopedSecretsResolver(inner, { loadMatrix: () => ENABLED, lookupAgentName });
    expect(await r.resolve("ws", { agentMemberId: "m-stranger" })).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "model",
    });
  });

  it("honors an explicit scope.agentName without a lookup", async () => {
    let looked = false;
    const r = new ScopedSecretsResolver(inner, {
      loadMatrix: () => ENABLED,
      lookupAgentName: () => {
        looked = true;
        return Promise.resolve(null);
      },
    });
    const out = await r.resolve("ws", { agentName: "scout" });
    expect(out).toEqual({ CRAWL_TOKEN: "c1", CLAUDE_CODE_OAUTH_TOKEN: "model" });
    expect(looked).toBe(false);
  });
});
