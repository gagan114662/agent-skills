import { describe, it, expect } from "vitest";
import {
  BillingSecretsResolver,
  EnvSecretsResolver,
} from "../../src/runtime/secrets-resolver.js";

/**
 * #98 billing credential resolution. The billing surface must see STRIPE_SECRET_KEY /
 * STRIPE_WEBHOOK_SECRET, but those keys must NOT leak into agent sessions — the session manager's
 * inner resolver is an EnvSecretsResolver, which only exposes process.env keys named in
 * AGENT_SECRET_KEYS. BillingSecretsResolver decouples billing from that agent-facing list.
 */
describe("BillingSecretsResolver (#98 — billing-only Stripe credentials)", () => {
  const WID = "019eb395-f4a4-796e-9ef0-3a538533566a";

  it("resolves the Stripe keys straight from env (no AGENT_SECRET_KEYS needed)", async () => {
    const r = new BillingSecretsResolver({
      STRIPE_SECRET_KEY: "sk_live_xxx",
      STRIPE_WEBHOOK_SECRET: "whsec_yyy",
    } as NodeJS.ProcessEnv);
    expect(await r.resolve(WID)).toEqual({
      STRIPE_SECRET_KEY: "sk_live_xxx",
      STRIPE_WEBHOOK_SECRET: "whsec_yyy",
    });
  });

  it("omits keys that are not set (no empty-string values)", async () => {
    const r = new BillingSecretsResolver({ STRIPE_SECRET_KEY: "sk_live_xxx" } as NodeJS.ProcessEnv);
    expect(await r.resolve(WID)).toEqual({ STRIPE_SECRET_KEY: "sk_live_xxx" });
  });

  it("honors per-tenant AGENT_SECRETS overrides over the env passthrough", async () => {
    const r = new BillingSecretsResolver({
      STRIPE_SECRET_KEY: "sk_live_shared",
      AGENT_SECRETS: JSON.stringify({ [WID]: { STRIPE_SECRET_KEY: "sk_live_tenant" } }),
    } as NodeJS.ProcessEnv);
    expect((await r.resolve(WID)).STRIPE_SECRET_KEY).toBe("sk_live_tenant");
  });

  it("does not pass through arbitrary env keys (fixed to the Stripe names)", async () => {
    const r = new BillingSecretsResolver({
      STRIPE_SECRET_KEY: "sk_live_xxx",
      SOME_OTHER_SECRET: "nope",
    } as NodeJS.ProcessEnv);
    const out = await r.resolve(WID);
    expect(out.SOME_OTHER_SECRET).toBeUndefined();
  });

  it("SECURITY: the agent-facing EnvSecretsResolver does NOT expose the Stripe key unless explicitly allowlisted", async () => {
    // This is the leak we must avoid: setting STRIPE_SECRET_KEY in env (a Fly secret) must NOT reach
    // agent sessions through the default resolver while AGENT_SECRET_KEYS doesn't name it.
    const env = new EnvSecretsResolver({ STRIPE_SECRET_KEY: "sk_live_xxx" } as NodeJS.ProcessEnv);
    expect(await env.resolve(WID)).toEqual({});
  });
});
