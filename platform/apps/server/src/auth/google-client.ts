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
  /**
   * Exchange a stored refresh token for a fresh access token (#660). Google does NOT return a new refresh
   * token on this grant, so the result's `refreshToken` is left unset — the caller preserves the existing
   * one. A revoked/expired refresh token surfaces as a {@link GoogleOAuthError} with `reauthRequired`
   * set, so the connector can mark itself "needs re-auth" instead of looping on a dead grant.
   */
  refreshAccessToken(refreshToken: string): Promise<GoogleTokens>;
}

/** A small error so the route can map a Google failure to a friendly redirect instead of a 500. */
export class GoogleOAuthError extends Error {
  /**
   * True when Google definitively rejected the credential (`401`, or a `400 invalid_grant` on refresh):
   * the user must re-consent. Distinguished from transient failures (5xx/network) so a refresh routine
   * only marks "needs re-auth" when re-auth is genuinely required, never on a blip.
   */
  readonly reauthRequired: boolean;
  constructor(message: string, options?: { reauthRequired?: boolean }) {
    super(message);
    this.name = "GoogleOAuthError";
    this.reauthRequired = options?.reauthRequired ?? false;
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
      let json: {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        token_type?: string;
      };
      try {
        const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
        if (!res.ok) throw new GoogleOAuthError(`token exchange returned ${res.status}`);
        // Parse inside the try so a non-JSON error body (HTML/plaintext during an outage) is wrapped too.
        json = (await res.json()) as typeof json;
      } catch (err) {
        if (err instanceof GoogleOAuthError) throw err;
        throw new GoogleOAuthError(`token exchange failed: ${(err as Error).message}`);
      }
      if (!json.access_token) throw new GoogleOAuthError("token exchange returned no access_token");
      return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresInSec: json.expires_in,
        scope: json.scope,
        tokenType: json.token_type,
      };
    },

    async refreshAccessToken(refreshToken) {
      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      });
      let json: {
        access_token?: string;
        expires_in?: number;
        scope?: string;
        token_type?: string;
        error?: string;
      };
      try {
        const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
        json = (await res.json().catch(() => ({}))) as typeof json;
        if (!res.ok) {
          // Google returns 400 `invalid_grant` when the refresh token is revoked/expired, and 401 for a
          // bad client — both mean re-auth is required. Other statuses (5xx) are transient.
          const reauthRequired =
            res.status === 401 || (res.status === 400 && json.error === "invalid_grant");
          throw new GoogleOAuthError(
            `token refresh returned ${res.status}${json.error ? ` (${json.error})` : ""}`,
            { reauthRequired },
          );
        }
      } catch (err) {
        if (err instanceof GoogleOAuthError) throw err;
        throw new GoogleOAuthError(`token refresh failed: ${(err as Error).message}`);
      }
      if (!json.access_token) throw new GoogleOAuthError("token refresh returned no access_token");
      return {
        accessToken: json.access_token,
        // Google omits the refresh token on this grant — the caller preserves the existing one.
        refreshToken: undefined,
        expiresInSec: json.expires_in,
        scope: json.scope,
        tokenType: json.token_type,
      };
    },

    async fetchUserInfo(accessToken) {
      let json: {
        sub?: string;
        email?: string;
        email_verified?: boolean | string;
        name?: string;
      };
      try {
        const res = await fetch(GOOGLE_USERINFO_ENDPOINT, {
          headers: { authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) throw new GoogleOAuthError(`userinfo returned ${res.status}`);
        // Parse inside the try so a non-JSON error body is wrapped as a GoogleOAuthError, not a SyntaxError.
        json = (await res.json()) as typeof json;
      } catch (err) {
        if (err instanceof GoogleOAuthError) throw err;
        throw new GoogleOAuthError(`userinfo failed: ${(err as Error).message}`);
      }
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
