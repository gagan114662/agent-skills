import { describe, expect, it } from "vitest";
import { parseOAuthDoctorConfig, runOAuthDoctor } from "../../src/connections/oauth-doctor-cli.js";

describe("OAuth connection doctor CLI (#1285)", () => {
  it("reports every missing provider env by name with no secrets", () => {
    const checks = runOAuthDoctor(parseOAuthDoctorConfig({}));

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "google-connection-oauth",
          status: "fail",
          missingEnv: expect.arrayContaining([
            "GOOGLE_OAUTH_CLIENT_ID",
            "GOOGLE_OAUTH_CLIENT_SECRET",
            "GOOGLE_CONNECTION_OAUTH_REDIRECT_URI",
          ]),
        }),
        expect.objectContaining({
          name: "x-connection-oauth",
          status: "fail",
          message: expect.stringContaining("X_OAUTH_CLIENT_ID"),
        }),
        expect.objectContaining({
          name: "meta_ads-connection-oauth",
          status: "fail",
          message: expect.stringContaining("META_ADS_CONNECTION_OAUTH_REDIRECT_URI"),
        }),
        expect.objectContaining({
          name: "linkedin-connection-oauth",
          status: "fail",
          message: expect.stringContaining("LINKEDIN_CONNECTION_OAUTH_REDIRECT_URI"),
        }),
      ]),
    );
  });

  it("passes when all connection OAuth providers are configured", () => {
    const env = {
      GOOGLE_OAUTH_CLIENT_ID: "google-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
      GOOGLE_CONNECTION_OAUTH_REDIRECT_URI:
        "https://api.ipop.ai/me/connections/google/oauth/callback",
      GOOGLE_ADS_CONNECTION_OAUTH_REDIRECT_URI:
        "https://api.ipop.ai/me/connections/google_ads/oauth/callback",
      X_OAUTH_CLIENT_ID: "x-client",
      X_OAUTH_CLIENT_SECRET: "x-secret",
      X_CONNECTION_OAUTH_REDIRECT_URI: "https://api.ipop.ai/me/connections/x/oauth/callback",
      META_OAUTH_CLIENT_ID: "meta-client",
      META_OAUTH_CLIENT_SECRET: "meta-secret",
      META_ADS_CONNECTION_OAUTH_REDIRECT_URI:
        "https://api.ipop.ai/me/connections/meta_ads/oauth/callback",
      LINKEDIN_OAUTH_CLIENT_ID: "linkedin-client",
      LINKEDIN_OAUTH_CLIENT_SECRET: "linkedin-secret",
      LINKEDIN_CONNECTION_OAUTH_REDIRECT_URI:
        "https://api.ipop.ai/me/connections/linkedin/oauth/callback",
    };

    const checks = runOAuthDoctor(parseOAuthDoctorConfig(env));

    expect(checks).toHaveLength(5);
    expect(checks.every((check) => check.status === "pass")).toBe(true);
    expect(checks.find((check) => check.name === "google_ads-connection-oauth")).toMatchObject({
      callbackPath: "/me/connections/google_ads/oauth/callback",
      redirectUri: "https://api.ipop.ai/me/connections/google_ads/oauth/callback",
      missingEnv: [],
    });
  });

  it("accepts Google sign-in redirect fallback for Google and Google Ads connection callbacks", () => {
    const env = {
      GOOGLE_OAUTH_CLIENT_ID: "google-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://api.ipop.ai/auth/google/callback?ignored=true",
    };

    const checks = runOAuthDoctor(parseOAuthDoctorConfig(env));

    expect(checks.find((check) => check.name === "google-connection-oauth")).toMatchObject({
      status: "pass",
      redirectUri: "https://api.ipop.ai/me/connections/google/oauth/callback",
      missingEnv: [],
    });
    expect(checks.find((check) => check.name === "google_ads-connection-oauth")).toMatchObject({
      status: "pass",
      redirectUri: "https://api.ipop.ai/me/connections/google_ads/oauth/callback",
      missingEnv: [],
    });
  });
});
