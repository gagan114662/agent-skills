import { describe, it, expect } from "vitest";
import { AgentAuthResolver } from "../../src/runtime/agent-auth.js";
import {
  SubscriptionSecretsResolver,
  StaticSecretsResolver,
} from "../../src/runtime/secrets-resolver.js";

/** An auth resolver whose vault returns a fixed map keyed by workspace. #246: there is NO platform key. */
function authResolver(tokens: Record<string, string>): AgentAuthResolver {
  return new AgentAuthResolver({
    getSubscriptionToken: (workspaceId) => Promise.resolve(tokens[workspaceId] ?? null),
  });
}

describe("AgentAuthResolver (#68/#246 — per-tenant, subscription-only)", () => {
  it("resolves subscription mode for a workspace with a connected token", async () => {
    const auth = await authResolver({ wsA: "tok-A" }).resolve("wsA");
    expect(auth).toEqual({ mode: "subscription", secrets: { CLAUDE_CODE_OAUTH_TOKEN: "tok-A" } });
  });

  it("#246: resolves none (NO API-key fallback) for a workspace with no token", async () => {
    const auth = await authResolver({}).resolve("wsB");
    expect(auth).toEqual({ mode: "none", secrets: {} });
  });

  it("never crosses tenants — wsB's resolve never sees wsA's token", async () => {
    const r = authResolver({ wsA: "tok-A" });
    expect((await r.resolve("wsA")).mode).toBe("subscription");
    expect((await r.resolve("wsB")).mode).toBe("none");
  });
});

describe("SubscriptionSecretsResolver (#68/#246 — injects the chosen auth as runtime env)", () => {
  it("injects the workspace subscription token", async () => {
    const r = new SubscriptionSecretsResolver(authResolver({ wsA: "tok-A" }));
    expect(await r.resolve("wsA")).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok-A" });
  });

  it("#246: injects nothing (NO API key) when the workspace has no token — connect-prompt handles it", async () => {
    const r = new SubscriptionSecretsResolver(authResolver({}));
    expect(await r.resolve("wsB")).toEqual({});
  });

  it("#246: an inner-resolver API key is STRIPPED even when the workspace has no subscription token", async () => {
    // A leaked ANTHROPIC_API_KEY must never reach the agent runtime, with or without a subscription.
    const extra = new StaticSecretsResolver({ ANTHROPIC_API_KEY: "sk-leak", CODEX_AUTH_JSON: "json" });
    const r = new SubscriptionSecretsResolver(authResolver({}), extra);
    const secrets = await r.resolve("wsB");
    expect(secrets).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(secrets).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(secrets.CODEX_AUTH_JSON).toBe("json");
  });

  it("subscription token wins — a leaked API key never ships alongside it from extra secrets", async () => {
    // The inner resolver leaks a platform key; the auth layer OWNS the credential keys, so it is stripped.
    const extra = new StaticSecretsResolver({ ANTHROPIC_API_KEY: "sk-leak", CODEX_AUTH_JSON: "json" });
    const r = new SubscriptionSecretsResolver(authResolver({ wsA: "tok-A" }), extra);
    const secrets = await r.resolve("wsA");
    expect(secrets.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-A");
    expect(secrets).not.toHaveProperty("ANTHROPIC_API_KEY");
    // Non-auth extra secrets still pass through.
    expect(secrets.CODEX_AUTH_JSON).toBe("json");
  });
});
