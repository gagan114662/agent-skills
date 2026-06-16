import {
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
  type GoogleOAuthConfig,
  type GoogleTokens,
  type GoogleUserInfo,
} from "./google-oauth.js";

/**
 * The thin IO seam for the #260 Google flow: exchange the authorization code for tokens, and read the
 * verified identity. Kept behind an interface so the route is unit/integration-testable WITHOUT network
 * (tests inject a fake) while production uses the real fetch-backed client.
 */
export interface GoogleOAuthClient {
  exchangeCode(input: { code: string }): Promise<GoogleTokens>;
  fetchUserInfo(accessToken: string): Promise<GoogleUserInfo>;
}

/** A small error so the route can map a Google failure to a friendly redirect instead of a 500. */
export class GoogleOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

/** The real client: standard OAuth 2.0 code exchange + OpenID Connect userinfo. No SDK dependency. */
export function createGoogleOAuthClient(config: GoogleOAuthConfig): GoogleOAuthClient {
  return {
    async exchangeCode({ code }) {
      const body = new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
      });
      let res: Response;
      try {
        res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
      } catch (err) {
        throw new GoogleOAuthError(`token exchange failed: ${(err as Error).message}`);
      }
      if (!res.ok) throw new GoogleOAuthError(`token exchange returned ${res.status}`);
      const json = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        token_type?: string;
      };
      if (!json.access_token) throw new GoogleOAuthError("token exchange returned no access_token");
      return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresInSec: json.expires_in,
        scope: json.scope,
        tokenType: json.token_type,
      };
    },

    async fetchUserInfo(accessToken) {
      let res: Response;
      try {
        res = await fetch(GOOGLE_USERINFO_ENDPOINT, {
          headers: { authorization: `Bearer ${accessToken}` },
        });
      } catch (err) {
        throw new GoogleOAuthError(`userinfo failed: ${(err as Error).message}`);
      }
      if (!res.ok) throw new GoogleOAuthError(`userinfo returned ${res.status}`);
      const json = (await res.json()) as {
        sub?: string;
        email?: string;
        email_verified?: boolean | string;
        name?: string;
      };
      if (!json.sub || !json.email) throw new GoogleOAuthError("userinfo missing sub/email");
      return {
        sub: json.sub,
        email: json.email.toLowerCase(),
        // Google returns email_verified as a boolean (OIDC) or "true"/"false" string (legacy) — accept both.
        emailVerified: json.email_verified === true || json.email_verified === "true",
        name: json.name,
      };
    },
  };
}
