import { describe, it, expect } from "vitest";
import { GoogleOAuthError } from "../../src/auth/google-client.js";
import type { GoogleTokens } from "../../src/auth/google-oauth.js";
import {
  parseExpiresAt,
  connectionNeedsReauth,
  shouldRefreshGoogleSecrets,
  mergeRefreshedGoogleSecrets,
  markNeedsReauthSecrets,
  isReauthRequiredError,
  GoogleTokenRefresher,
  DEFAULT_REFRESH_SKEW_MS,
  GOOGLE_ACCESS_TOKEN_KEY,
  GOOGLE_REFRESH_TOKEN_KEY,
  GOOGLE_EXPIRES_AT_KEY,
  GOOGLE_NEEDS_REAUTH_KEY,
} from "../../src/connections/oauth-refresh.js";

const NOW = 1_000_000;
const SKEW = DEFAULT_REFRESH_SKEW_MS; // 120_000

/** Secrets whose access token expires `inMs` from NOW. */
function secretsExpiring(inMs: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    [GOOGLE_ACCESS_TOKEN_KEY]: "at-old",
    [GOOGLE_REFRESH_TOKEN_KEY]: "rt-1",
    [GOOGLE_EXPIRES_AT_KEY]: String(NOW + inMs),
    GOOGLE_OAUTH_SCOPE: "openid https://www.googleapis.com/auth/webmasters",
    GOOGLE_ACCOUNT_EMAIL: "founder@acme.com",
    ...extra,
  };
}

describe("oauth-refresh pure helpers (#660)", () => {
  it("parseExpiresAt reads the absolute epoch ms (or null when absent/garbage)", () => {
    expect(parseExpiresAt({ [GOOGLE_EXPIRES_AT_KEY]: "1700000000000" })).toBe(1_700_000_000_000);
    expect(parseExpiresAt({})).toBeNull();
    expect(parseExpiresAt({ [GOOGLE_EXPIRES_AT_KEY]: "nope" })).toBeNull();
  });

  it("shouldRefreshGoogleSecrets is true only within the skew window AND with a refresh token", () => {
    // Far from expiry → no refresh.
    expect(shouldRefreshGoogleSecrets(secretsExpiring(10 * 60_000), NOW, SKEW)).toBe(false);
    // Within skew → refresh.
    expect(shouldRefreshGoogleSecrets(secretsExpiring(60_000), NOW, SKEW)).toBe(true);
    // Already expired → refresh.
    expect(shouldRefreshGoogleSecrets(secretsExpiring(-5_000), NOW, SKEW)).toBe(true);
    // No refresh token → can't refresh.
    const noRt = secretsExpiring(60_000);
    delete noRt[GOOGLE_REFRESH_TOKEN_KEY];
    expect(shouldRefreshGoogleSecrets(noRt, NOW, SKEW)).toBe(false);
    // No expiry recorded → never proactively refreshed.
    const noExp = secretsExpiring(60_000);
    delete noExp[GOOGLE_EXPIRES_AT_KEY];
    expect(shouldRefreshGoogleSecrets(noExp, NOW, SKEW)).toBe(false);
    // Already flagged needs-reauth → don't keep trying.
    expect(shouldRefreshGoogleSecrets(secretsExpiring(60_000, { [GOOGLE_NEEDS_REAUTH_KEY]: "1" }), NOW, SKEW)).toBe(
      false,
    );
  });

  it("mergeRefreshedGoogleSecrets updates the access token + expiry, PRESERVES the refresh token", () => {
    const prev = secretsExpiring(60_000);
    const refreshed: GoogleTokens = { accessToken: "at-new", expiresInSec: 3600, scope: "openid x" };
    const merged = mergeRefreshedGoogleSecrets(prev, refreshed, NOW);
    expect(merged[GOOGLE_ACCESS_TOKEN_KEY]).toBe("at-new");
    // Google omits the refresh token on a refresh grant → the old one is preserved.
    expect(merged[GOOGLE_REFRESH_TOKEN_KEY]).toBe("rt-1");
    expect(merged[GOOGLE_EXPIRES_AT_KEY]).toBe(String(NOW + 3600 * 1000));
    expect(merged.GOOGLE_OAUTH_SCOPE).toBe("openid x");
    // Identity fields carried through.
    expect(merged.GOOGLE_ACCOUNT_EMAIL).toBe("founder@acme.com");
  });

  it("mergeRefreshedGoogleSecrets clears a stale needs-reauth flag (the grant just proved good)", () => {
    const prev = secretsExpiring(60_000, { [GOOGLE_NEEDS_REAUTH_KEY]: "1" });
    const merged = mergeRefreshedGoogleSecrets(prev, { accessToken: "at-new", expiresInSec: 60 }, NOW);
    expect(connectionNeedsReauth(merged)).toBe(false);
  });

  it("markNeedsReauthSecrets flags re-auth and clears the dead access token", () => {
    const flagged = markNeedsReauthSecrets(secretsExpiring(60_000));
    expect(connectionNeedsReauth(flagged)).toBe(true);
    expect(flagged[GOOGLE_ACCESS_TOKEN_KEY]).toBeUndefined();
    expect(flagged[GOOGLE_EXPIRES_AT_KEY]).toBeUndefined();
    // The refresh token row survives as a record of what was connected.
    expect(flagged[GOOGLE_REFRESH_TOKEN_KEY]).toBe("rt-1");
  });

  it("isReauthRequiredError distinguishes a dead grant from a transient failure", () => {
    expect(isReauthRequiredError(new GoogleOAuthError("invalid_grant", { reauthRequired: true }))).toBe(true);
    expect(isReauthRequiredError(new GoogleOAuthError("503"))).toBe(false);
    expect(isReauthRequiredError(new Error("boom"))).toBe(false);
  });
});

/** A fake vault + refresh client for the IO tests. */
function makeRefresher(opts: {
  initial: Record<string, string>;
  refresh?: (rt: string) => Promise<GoogleTokens>;
  now?: number;
}) {
  const store = new Map<string, Record<string, string>>([["ws1", { ...opts.initial }]]);
  let refreshCalls = 0;
  const writes: Record<string, string>[] = [];
  const refresher = new GoogleTokenRefresher({
    readSecrets: async (ws) => ({ ...(store.get(ws) ?? {}) }),
    writeSecrets: async (ws, secrets) => {
      writes.push({ ...secrets });
      store.set(ws, { ...secrets });
    },
    refresh: async (rt) => {
      refreshCalls += 1;
      if (opts.refresh) return opts.refresh(rt);
      return { accessToken: "at-new", expiresInSec: 3600 };
    },
    now: () => opts.now ?? NOW,
  });
  return { refresher, store, writes, refreshCalls: () => refreshCalls };
}

describe("GoogleTokenRefresher.resolveFresh (#660 — proactive refresh before expiry)", () => {
  it("leaves a not-near-expiry token untouched (no refresh, same secrets)", async () => {
    const h = makeRefresher({ initial: secretsExpiring(10 * 60_000) });
    const res = await h.refresher.resolveFresh("ws1");
    expect(res.refreshed).toBe(false);
    expect(res.needsReauth).toBe(false);
    expect(res.secrets[GOOGLE_ACCESS_TOKEN_KEY]).toBe("at-old");
    expect(h.refreshCalls()).toBe(0);
  });

  it("a run spanning expiry refreshes transparently and continues with the new token", async () => {
    const h = makeRefresher({ initial: secretsExpiring(30_000) }); // inside skew
    const res = await h.refresher.resolveFresh("ws1");
    expect(res.refreshed).toBe(true);
    expect(res.secrets[GOOGLE_ACCESS_TOKEN_KEY]).toBe("at-new");
    expect(res.secrets[GOOGLE_EXPIRES_AT_KEY]).toBe(String(NOW + 3600 * 1000));
    // Re-sealed into the vault, refresh token preserved.
    expect(h.store.get("ws1")![GOOGLE_ACCESS_TOKEN_KEY]).toBe("at-new");
    expect(h.store.get("ws1")![GOOGLE_REFRESH_TOKEN_KEY]).toBe("rt-1");
    expect(h.refreshCalls()).toBe(1);
  });

  it("returns offline for an unconnected workspace", async () => {
    const h = makeRefresher({ initial: {} });
    expect(await h.refresher.resolveFresh("ws1")).toEqual({ secrets: {}, refreshed: false, needsReauth: false });
  });

  it("marks needs-reauth (and goes offline) when the refresh token is dead (invalid_grant)", async () => {
    const h = makeRefresher({
      initial: secretsExpiring(30_000),
      refresh: async () => {
        throw new GoogleOAuthError("invalid_grant", { reauthRequired: true });
      },
    });
    const res = await h.refresher.resolveFresh("ws1");
    expect(res.needsReauth).toBe(true);
    expect(res.secrets).toEqual({});
    // The vault row is flagged so the UI can prompt re-consent.
    expect(connectionNeedsReauth(h.store.get("ws1")!)).toBe(true);
  });

  it("falls back to the existing token on a TRANSIENT refresh failure (never breaks a run on a blip)", async () => {
    const h = makeRefresher({
      initial: secretsExpiring(30_000),
      refresh: async () => {
        throw new GoogleOAuthError("token refresh returned 503");
      },
    });
    const res = await h.refresher.resolveFresh("ws1");
    expect(res.needsReauth).toBe(false);
    expect(res.refreshed).toBe(false);
    expect(res.secrets[GOOGLE_ACCESS_TOKEN_KEY]).toBe("at-old");
  });

  it("single-flights a concurrent refresh stampede into ONE token exchange", async () => {
    const h = makeRefresher({ initial: secretsExpiring(30_000) });
    const [a, b, c] = await Promise.all([
      h.refresher.resolveFresh("ws1"),
      h.refresher.resolveFresh("ws1"),
      h.refresher.resolveFresh("ws1"),
    ]);
    expect(a.secrets[GOOGLE_ACCESS_TOKEN_KEY]).toBe("at-new");
    expect(b.secrets[GOOGLE_ACCESS_TOKEN_KEY]).toBe("at-new");
    expect(c.secrets[GOOGLE_ACCESS_TOKEN_KEY]).toBe("at-new");
    expect(h.refreshCalls()).toBe(1);
  });
});

describe("GoogleTokenRefresher.withTokenRefresh (#660 — reactive refresh on 401)", () => {
  it("passes a successful call straight through (no refresh needed)", async () => {
    const h = makeRefresher({ initial: secretsExpiring(10 * 60_000) });
    const res = await h.refresher.withTokenRefresh("ws1", async (token) => {
      expect(token).toBe("at-old");
      return { status: 200, value: "ok" };
    });
    expect(res).toEqual({ status: 200, value: "ok", needsReauth: false });
    expect(h.refreshCalls()).toBe(0);
  });

  it("on a 401 it refreshes once and retries once, then succeeds", async () => {
    const h = makeRefresher({ initial: secretsExpiring(10 * 60_000) });
    const seen: string[] = [];
    const res = await h.refresher.withTokenRefresh("ws1", async (token) => {
      seen.push(token);
      return token === "at-old" ? { status: 401, value: "" } : { status: 200, value: "recovered" };
    });
    expect(seen).toEqual(["at-old", "at-new"]); // first with old, retry with refreshed
    expect(res).toEqual({ status: 200, value: "recovered", needsReauth: false });
    expect(h.refreshCalls()).toBe(1);
  });

  it("a 401 that survives a genuine refresh flips the connection to needs-reauth", async () => {
    const h = makeRefresher({ initial: secretsExpiring(10 * 60_000) });
    const res = await h.refresher.withTokenRefresh("ws1", async () => ({ status: 401, value: "" }));
    expect(res.needsReauth).toBe(true);
    expect(res.status).toBe(401);
    expect(connectionNeedsReauth(h.store.get("ws1")!)).toBe(true);
  });

  it("short-circuits to needs-reauth when the connection is already offline", async () => {
    const h = makeRefresher({ initial: {} });
    let called = false;
    const res = await h.refresher.withTokenRefresh("ws1", async () => ((called = true), { status: 200, value: "x" }));
    expect(res).toEqual({ status: 401, needsReauth: true });
    expect(called).toBe(false);
  });
});
