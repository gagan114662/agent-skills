import { describe, it, expect } from "vitest";
import { AgentAuthResolver } from "../../src/runtime/agent-auth.js";
import {
  SubscriptionSecretsResolver,
  StaticSecretsResolver,
} from "../../src/runtime/secrets-resolver.js";

/** An auth resolver whose vault returns a fixed map keyed by workspace, and a fixed platform key. */
function authResolver(tokens: Record<string, string>, platformKey: string | null): AgentAuthResolver {
  return new AgentAuthResolver({
    getSubscriptionToken: (workspaceId) => Promise.resolve(tokens[workspaceId] ?? null),
    platformKey: () => platformKey,
  });
}

describe("AgentAuthResolver (#68 — per-tenant auth resolution)", () => {
  it("resolves subscription mode for a workspace with a connected token", async () => {
    const auth = await authResolver({ wsA: "tok-A" }, null).resolve("wsA");
    expect(auth).toEqual({ mode: "subscription", secrets: { CLAUDE_CODE_OAUTH_TOKEN: "tok-A" } });
  });

  it("resolves platform fallback for a workspace with no token when a platform key exists", async () => {
    const auth = await authResolver({}, "sk-platform").resolve("wsB");
    expect(auth).toEqual({ mode: "platform", secrets: { ANTHROPIC_API_KEY: "sk-platform" } });
  });

  it("resolves none when neither a token nor a platform key exists", async () => {
    expect((await authResolver({}, null).resolve("wsC")).mode).toBe("none");
  });

  it("never crosses tenants — wsB's resolve never sees wsA's token", async () => {
    const r = authResolver({ wsA: "tok-A" }, null);
    expect((await r.resolve("wsA")).mode).toBe("subscription");
    expect((await r.resolve("wsB")).mode).toBe("none");
  });
});

describe("SubscriptionSecretsResolver (#68 — injects the chosen auth as runtime env)", () => {
  it("injects the workspace subscription token", async () => {
    const r = new SubscriptionSecretsResolver(authResolver({ wsA: "tok-A" }, "sk-platform"));
    expect(await r.resolve("wsA")).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok-A" });
  });

  it("falls back to the platform key when the workspace has no token", async () => {
    const r = new SubscriptionSecretsResolver(authResolver({}, "sk-platform"));
    expect(await r.resolve("wsB")).toEqual({ ANTHROPIC_API_KEY: "sk-platform" });
  });

  it("injects nothing when neither is configured (the connect-prompt path handles this)", async () => {
    const r = new SubscriptionSecretsResolver(authResolver({}, null));
    expect(await r.resolve("wsC")).toEqual({});
  });

  it("subscription token wins — a platform key never ships alongside it from extra secrets", async () => {
    // The inner resolver leaks a platform key; the auth layer OWNS the credential keys, so it is stripped.
    const extra = new StaticSecretsResolver({ ANTHROPIC_API_KEY: "sk-leak", OPENAI_API_KEY: "sk-oai" });
    const r = new SubscriptionSecretsResolver(authResolver({ wsA: "tok-A" }, null), extra);
    const secrets = await r.resolve("wsA");
    expect(secrets.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-A");
    expect(secrets).not.toHaveProperty("ANTHROPIC_API_KEY");
    // Non-auth extra secrets still pass through.
    expect(secrets.OPENAI_API_KEY).toBe("sk-oai");
  });
});
