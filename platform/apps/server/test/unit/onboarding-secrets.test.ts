import { describe, it, expect } from "vitest";
import {
  ExternalSecretsResolver,
  StaticSecretsResolver,
  type SecretsResolver,
} from "../../src/runtime/secrets-resolver.js";
import { resolveOnboardingCaps, ONBOARDING_DEFAULTS } from "../../src/onboarding/caps.js";
import { mergeLayers } from "../../src/config/layers.js";

describe("ExternalSecretsResolver (#192)", () => {
  const inner: SecretsResolver = new StaticSecretsResolver({ OPENAI_API_KEY: "inner" });

  it("is a byte-for-byte no-op when the workspace has NOT opted in (default-OFF)", async () => {
    let loaded = false;
    const r = new ExternalSecretsResolver(inner, {
      isEnabled: () => false,
      loadServiceSecrets: async () => {
        loaded = true;
        return { SENDGRID_API_KEY: "SG.x" };
      },
    });
    expect(await r.resolve("ws1")).toEqual({ OPENAI_API_KEY: "inner" });
    expect(loaded).toBe(false); // never even reads the vault when disabled
  });

  it("merges connected external secrets when enabled (connected values win for their keys)", async () => {
    const r = new ExternalSecretsResolver(inner, {
      isEnabled: () => true,
      loadServiceSecrets: async () => ({ SENDGRID_API_KEY: "SG.x", OPENAI_API_KEY: "external-wins" }),
    });
    expect(await r.resolve("ws1")).toEqual({
      OPENAI_API_KEY: "external-wins",
      SENDGRID_API_KEY: "SG.x",
    });
  });

  it("passes the workspace id through to both seams", async () => {
    const seen: string[] = [];
    const r = new ExternalSecretsResolver(
      { resolve: async (wid) => ({ wid }) },
      {
        isEnabled: (wid) => {
          seen.push(`enabled:${wid}`);
          return true;
        },
        loadServiceSecrets: async (wid) => {
          seen.push(`load:${wid}`);
          return {};
        },
      },
    );
    await r.resolve("ws-42");
    expect(seen).toEqual(["enabled:ws-42", "load:ws-42"]);
  });
});

describe("resolveOnboardingCaps (#192)", () => {
  it("defaults to OFF with the dry-run DNS provider", () => {
    expect(resolveOnboardingCaps(undefined)).toEqual(ONBOARDING_DEFAULTS);
    expect(resolveOnboardingCaps({}).enabled).toBe(false);
    expect(resolveOnboardingCaps({}).dnsProvider).toBe("dryrun");
  });

  it("honors an explicit opt-in + overrides", () => {
    const caps = resolveOnboardingCaps({ enabled: true, defaultRotationDays: 90, dnsProvider: "cloudflare" });
    expect(caps).toEqual({ enabled: true, defaultRotationDays: 90, dnsProvider: "cloudflare" });
  });
});

describe("onboarding config layering (the 5-sites gotcha)", () => {
  it("resolves to an empty default block and is NOT dropped by the merge", () => {
    expect(mergeLayers([]).onboarding).toEqual({});
  });

  it("lets a higher layer own the block (managed lock semantics)", () => {
    const resolved = mergeLayers([{ onboarding: { enabled: true } }, { onboarding: { enabled: false } }]);
    expect(resolved.onboarding).toEqual({ enabled: false });
  });
});
