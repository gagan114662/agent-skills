import { describe, it, expect, vi, afterEach } from "vitest";
import { createGoogleOAuthClient, GoogleOAuthError } from "../../src/auth/google-client.js";

const CONFIG = {
  clientId: "cid.apps.googleusercontent.com",
  clientSecret: "secret",
  redirectUri: "https://api.ipop.ai/auth/google/callback",
};

/** A minimal fake fetch Response for the token endpoint. */
function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createGoogleOAuthClient.refreshAccessToken (#660)", () => {
  it("retries a transient authorization-code exchange failure and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(503, {}))
      .mockResolvedValueOnce(
        res(200, { access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = createGoogleOAuthClient(CONFIG);
    const tokens = await client.exchangeCode({ code: "code-1" });

    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a clear error after persistent authorization-code exchange failures", async () => {
    const fetchMock = vi.fn(async () => res(503, {}));
    vi.stubGlobal("fetch", fetchMock);

    const client = createGoogleOAuthClient(CONFIG);
    await expect(client.exchangeCode({ code: "code-1" })).rejects.toThrow("token exchange returned 503");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("exchanges a refresh token for a fresh access token, preserving (omitting) the refresh token", async () => {
    const fetchMock = vi.fn(async () =>
      res(200, { access_token: "at-new", expires_in: 3600, scope: "openid x", token_type: "Bearer" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createGoogleOAuthClient(CONFIG);
    const tokens = await client.refreshAccessToken("rt-1");

    expect(tokens.accessToken).toBe("at-new");
    expect(tokens.expiresInSec).toBe(3600);
    expect(tokens.refreshToken).toBeUndefined(); // Google omits it on a refresh grant
    // Sent the refresh_token grant with the stored refresh token.
    const body = fetchMock.mock.calls[0][1]!.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
  });

  it("flags reauthRequired on a 400 invalid_grant (revoked/expired refresh token)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(400, { error: "invalid_grant" })));
    const client = createGoogleOAuthClient(CONFIG);
    await expect(client.refreshAccessToken("rt-dead")).rejects.toMatchObject({
      name: "GoogleOAuthError",
      reauthRequired: true,
    });
  });

  it("flags reauthRequired on a 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(401, { error: "invalid_client" })));
    const client = createGoogleOAuthClient(CONFIG);
    await expect(client.refreshAccessToken("rt-1")).rejects.toMatchObject({ reauthRequired: true });
  });

  it("does NOT flag reauthRequired on a transient 5xx", async () => {
    const fetchMock = vi.fn(async () => res(503, {}));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGoogleOAuthClient(CONFIG);
    try {
      await client.refreshAccessToken("rt-1");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GoogleOAuthError);
      expect((err as GoogleOAuthError).reauthRequired).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }
  });

  it("retries a transient refresh failure and succeeds without requiring reauth", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(503, {}))
      .mockResolvedValueOnce(res(200, { access_token: "at-new", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createGoogleOAuthClient(CONFIG);
    await expect(client.refreshAccessToken("rt-1")).resolves.toMatchObject({ accessToken: "at-new" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when a 200 response carries no access_token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { expires_in: 3600 })));
    const client = createGoogleOAuthClient(CONFIG);
    await expect(client.refreshAccessToken("rt-1")).rejects.toThrow(/no access_token/);
  });
});
