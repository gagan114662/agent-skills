import { describe, it, expect } from "vitest";
import {
  loadGoogleOAuthConfig,
  buildGoogleAuthorizeUrl,
  googleConnectionSecrets,
  resolveOnboardingScopes,
  capabilitiesForScopes,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_IDENTITY_SCOPES,
  GOOGLE_SEARCH_CONSOLE_SCOPE,
  GOOGLE_ANALYTICS_SCOPE,
  GOOGLE_CONNECTION_SERVICE_KEY,
  GOOGLE_CONNECTION_CAPABILITIES,
} from "../../src/auth/google-oauth.js";

const CONFIG = {
  clientId: "cid.apps.googleusercontent.com",
  clientSecret: "secret",
  redirectUri: "https://api.ipop.ai/auth/google/callback",
};

describe("google-oauth scopes (#260 — one consent = identity + GSC + GA)", () => {
  it("the single consent covers identity, Search Console, and Analytics", () => {
    for (const s of GOOGLE_IDENTITY_SCOPES) expect(GOOGLE_OAUTH_SCOPES).toContain(s);
    expect(GOOGLE_OAUTH_SCOPES).toContain(GOOGLE_SEARCH_CONSOLE_SCOPE);
    expect(GOOGLE_OAUTH_SCOPES).toContain(GOOGLE_ANALYTICS_SCOPE);
    // Search Console must be read+write (sitemap submit / indexing), not read-only.
    expect(GOOGLE_SEARCH_CONSOLE_SCOPE).toBe("https://www.googleapis.com/auth/webmasters");
  });

  it("reconciles with the #258 connection model: service_key 'google' + capability list", () => {
    expect(GOOGLE_CONNECTION_SERVICE_KEY).toBe("google");
    expect([...GOOGLE_CONNECTION_CAPABILITIES]).toEqual(["identity", "search_console", "analytics"]);
  });
});

describe("loadGoogleOAuthConfig", () => {
  it("returns null unless all three env vars are present", () => {
    expect(loadGoogleOAuthConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      loadGoogleOAuthConfig({ GOOGLE_OAUTH_CLIENT_ID: "x" } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      loadGoogleOAuthConfig({
        GOOGLE_OAUTH_CLIENT_ID: "x",
        GOOGLE_OAUTH_CLIENT_SECRET: "y",
        GOOGLE_OAUTH_REDIRECT_URI: "https://z/cb",
      } as NodeJS.ProcessEnv),
    ).toEqual({ clientId: "x", clientSecret: "y", redirectUri: "https://z/cb" });
  });
});

describe("buildGoogleAuthorizeUrl", () => {
  it("builds an offline-access consent URL carrying the state + every scope", () => {
    const url = new URL(buildGoogleAuthorizeUrl({ config: CONFIG, state: "st8" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    expect(q.get("client_id")).toBe(CONFIG.clientId);
    expect(q.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("include_granted_scopes")).toBe("true");
    expect(q.get("state")).toBe("st8");
    expect(q.get("scope")).toBe(GOOGLE_OAUTH_SCOPES.join(" "));
  });
});

describe("googleConnectionSecrets", () => {
  it("maps tokens + identity into the sealed vault env map with an absolute expiry", () => {
    const secrets = googleConnectionSecrets(
      { accessToken: "at", refreshToken: "rt", expiresInSec: 3600, scope: "a b", tokenType: "Bearer" },
      { sub: "123", email: "founder@acme.com" },
      1_000,
    );
    expect(secrets.GOOGLE_OAUTH_ACCESS_TOKEN).toBe("at");
    expect(secrets.GOOGLE_OAUTH_REFRESH_TOKEN).toBe("rt");
    expect(secrets.GOOGLE_OAUTH_EXPIRES_AT).toBe(String(1_000 + 3600 * 1000));
    expect(secrets.GOOGLE_ACCOUNT_SUB).toBe("123");
    expect(secrets.GOOGLE_ACCOUNT_EMAIL).toBe("founder@acme.com");
  });

  it("omits the refresh token + expiry when Google didn't return them (re-consent without offline)", () => {
    const secrets = googleConnectionSecrets({ accessToken: "at" }, { sub: "1", email: "x@y.com" });
    expect(secrets.GOOGLE_OAUTH_REFRESH_TOKEN).toBeUndefined();
    expect(secrets.GOOGLE_OAUTH_EXPIRES_AT).toBeUndefined();
    expect(secrets.GOOGLE_OAUTH_ACCESS_TOKEN).toBe("at");
  });
});

describe("resolveOnboardingScopes (#300 — progressive consent, default OFF)", () => {
  it("progressive OFF ⇒ full set at signup AND at SEO (today's #260 single consent)", () => {
    expect(resolveOnboardingScopes({ progressive: false, intent: "signup" })).toEqual(GOOGLE_OAUTH_SCOPES);
    expect(resolveOnboardingScopes({ progressive: false, intent: "seo" })).toEqual(GOOGLE_OAUTH_SCOPES);
  });

  it("progressive ON ⇒ identity-only at signup (no GSC/Analytics), full set when SEO is initiated", () => {
    const signup = resolveOnboardingScopes({ progressive: true, intent: "signup" });
    expect(signup).toEqual([...GOOGLE_IDENTITY_SCOPES]);
    expect(signup).not.toContain(GOOGLE_SEARCH_CONSOLE_SCOPE);
    expect(signup).not.toContain(GOOGLE_ANALYTICS_SCOPE);

    const seo = resolveOnboardingScopes({ progressive: true, intent: "seo" });
    expect(seo).toContain(GOOGLE_SEARCH_CONSOLE_SCOPE);
    expect(seo).toContain(GOOGLE_ANALYTICS_SCOPE);
  });
});

describe("capabilitiesForScopes (#300 — recorded connection capabilities)", () => {
  it("the full scope set maps back to the #258 capability list exactly", () => {
    expect(capabilitiesForScopes(GOOGLE_OAUTH_SCOPES)).toEqual([...GOOGLE_CONNECTION_CAPABILITIES]);
  });

  it("an identity-only signup consent records only identity (GSC/Analytics deferred)", () => {
    expect(capabilitiesForScopes([...GOOGLE_IDENTITY_SCOPES])).toEqual(["identity"]);
  });

  it("ignores unknown scopes and stays order-stable", () => {
    expect(capabilitiesForScopes(["openid", GOOGLE_ANALYTICS_SCOPE, "bogus"])).toEqual([
      "identity",
      "analytics",
    ]);
  });
});
