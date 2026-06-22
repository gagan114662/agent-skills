/**
 * Connector OAuth token refresh (#660) — don't let a token expire mid-run.
 *
 * THE failure this prevents: a connector's Google access token expires partway through a long run, every
 * subsequent API call 401s, and the run breaks with no recovery — even though a perfectly good refresh
 * token was sitting sealed in the vault the whole time, never used. Tokens were written once at connect
 * time and read raw thereafter.
 *
 * This module adds the missing refresh, in two shapes the issue asks for:
 *   (a) PROACTIVE — `GoogleTokenRefresher.resolveFresh` reads the sealed secrets and, if the access token
 *       is within a skew window of expiry, exchanges the refresh token for a new access token, re-seals,
 *       and returns the fresh map. A run that spans an expiry boundary refreshes transparently and
 *       continues.
 *   (b) REACTIVE — `withTokenRefresh` wraps a connector API call: a `401` despite the proactive refresh
 *       (revoked token, clock skew) forces one refresh + one retry before giving up.
 * When the refresh token itself is dead (`invalid_grant` / `401`), the connection is marked NEEDS-REAUTH
 * so the UI can prompt re-consent instead of looping on a dead grant.
 *
 * Storage is migration-free by design (it matches the self-contained-module convention): expiry lives
 * inside the sealed blob as `GOOGLE_OAUTH_EXPIRES_AT` (absolute epoch ms), and "needs re-auth" is a blob
 * flag (`GOOGLE_OAUTH_NEEDS_REAUTH`) rather than a new `external_credentials.status` enum value — so no
 * schema/enum/check-constraint migration is touched. The pure half (parse / decide / merge) is exported
 * for unit testing; the IO half takes injected seams so it runs with no DB and no network in tests.
 */

import type { GoogleTokens } from "../auth/google-oauth.js";
import { GoogleOAuthError } from "../auth/google-client.js";

/** The sealed-blob env keys this module reads + writes. */
export const GOOGLE_ACCESS_TOKEN_KEY = "GOOGLE_OAUTH_ACCESS_TOKEN";
export const GOOGLE_REFRESH_TOKEN_KEY = "GOOGLE_OAUTH_REFRESH_TOKEN";
export const GOOGLE_EXPIRES_AT_KEY = "GOOGLE_OAUTH_EXPIRES_AT";
export const GOOGLE_SCOPE_KEY = "GOOGLE_OAUTH_SCOPE";
export const GOOGLE_TOKEN_TYPE_KEY = "GOOGLE_OAUTH_TOKEN_TYPE";
/** Blob flag (migration-free) marking a connection whose refresh token is dead — re-consent required. */
export const GOOGLE_NEEDS_REAUTH_KEY = "GOOGLE_OAUTH_NEEDS_REAUTH";

/** Default refresh-ahead skew: refresh when the access token is within 2 minutes of expiry. */
export const DEFAULT_REFRESH_SKEW_MS = 120_000;

type Secrets = Record<string, string>;

/** Parse the absolute expiry (epoch ms) from a sealed secrets map, or null when absent/unparseable. */
export function parseExpiresAt(secrets: Secrets): number | null {
  const raw = secrets[GOOGLE_EXPIRES_AT_KEY];
  if (!raw) return null;
  const ms = Number(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** Whether a connection is flagged NEEDS-REAUTH (its refresh token is dead). */
export function connectionNeedsReauth(secrets: Secrets): boolean {
  return secrets[GOOGLE_NEEDS_REAUTH_KEY] === "1";
}

/**
 * Pure decision: should we refresh now? True only when there is a refresh token to use, a known expiry,
 * and we are within `skewMs` of (or past) that expiry. No clock/IO — `now` is passed in. A connection
 * with no expiry recorded (e.g. a non-offline consent) is never proactively refreshed.
 */
export function shouldRefreshGoogleSecrets(secrets: Secrets, now: number, skewMs: number): boolean {
  if (!secrets[GOOGLE_REFRESH_TOKEN_KEY]) return false;
  if (connectionNeedsReauth(secrets)) return false;
  const expiresAt = parseExpiresAt(secrets);
  if (expiresAt === null) return false;
  return now + skewMs >= expiresAt;
}

/**
 * Pure: merge a freshly-refreshed token response back into the prior sealed map. The access token + a
 * recomputed absolute expiry are updated; the refresh token is PRESERVED (Google omits it on a refresh
 * grant); scope/token-type are updated only when the response carries them; identity fields and anything
 * else in the blob are carried through; any stale needs-reauth flag is cleared (we just proved the grant
 * works).
 */
export function mergeRefreshedGoogleSecrets(
  prev: Secrets,
  refreshed: GoogleTokens,
  now: number,
): Secrets {
  const next: Secrets = { ...prev };
  next[GOOGLE_ACCESS_TOKEN_KEY] = refreshed.accessToken;
  if (refreshed.refreshToken) next[GOOGLE_REFRESH_TOKEN_KEY] = refreshed.refreshToken;
  if (typeof refreshed.expiresInSec === "number") {
    next[GOOGLE_EXPIRES_AT_KEY] = String(now + refreshed.expiresInSec * 1000);
  } else {
    delete next[GOOGLE_EXPIRES_AT_KEY];
  }
  if (refreshed.scope) next[GOOGLE_SCOPE_KEY] = refreshed.scope;
  if (refreshed.tokenType) next[GOOGLE_TOKEN_TYPE_KEY] = refreshed.tokenType;
  delete next[GOOGLE_NEEDS_REAUTH_KEY];
  return next;
}

/**
 * Pure: the sealed map for a connection whose refresh token is dead — flag NEEDS-REAUTH and clear the
 * (now useless) access token so any consumer goes offline gracefully until the user re-consents. The
 * refresh token is kept so the row still records what was connected; the access token is removed.
 */
export function markNeedsReauthSecrets(prev: Secrets): Secrets {
  const next: Secrets = { ...prev };
  next[GOOGLE_NEEDS_REAUTH_KEY] = "1";
  delete next[GOOGLE_ACCESS_TOKEN_KEY];
  delete next[GOOGLE_EXPIRES_AT_KEY];
  return next;
}

/** Whether an error from a refresh attempt definitively requires re-auth (vs a transient failure). */
export function isReauthRequiredError(err: unknown): boolean {
  return err instanceof GoogleOAuthError && err.reauthRequired;
}

/** The outcome of resolving a connection's secrets with proactive refresh applied. */
export interface FreshSecretsResult {
  /** The current (possibly just-refreshed) secrets; `{}` when offline / needs re-auth. */
  secrets: Secrets;
  /** Whether a live refresh actually happened on this call. */
  refreshed: boolean;
  /** Whether the connection now needs re-auth (refresh token dead). */
  needsReauth: boolean;
}

/** Injected seams — keeps the refresher DB-free and network-free under unit test. */
export interface GoogleTokenRefresherDeps {
  /** Read the connection's decrypted secrets (`{}` when not connected). */
  readSecrets(workspaceId: string): Promise<Secrets>;
  /** Re-seal the connection's secrets (preserving scopes is the impl's responsibility). */
  writeSecrets(workspaceId: string, secrets: Secrets): Promise<void>;
  /** Exchange a refresh token for a fresh access token. */
  refresh(refreshToken: string): Promise<GoogleTokens>;
  /** Clock seam (defaults to Date.now). */
  now?: () => number;
  /** Refresh-ahead skew window (defaults to {@link DEFAULT_REFRESH_SKEW_MS}). */
  skewMs?: number;
}

/**
 * Resolves a connector's Google secrets with proactive + reactive refresh. Per-workspace single-flight
 * collapses a refresh stampede (many tools firing at once) into one token exchange + one re-seal, so the
 * last-write-wins vault upsert can't race itself.
 */
export class GoogleTokenRefresher {
  private readonly inFlight = new Map<string, Promise<FreshSecretsResult>>();
  private readonly now: () => number;
  private readonly skewMs: number;

  constructor(private readonly deps: GoogleTokenRefresherDeps) {
    this.now = deps.now ?? Date.now;
    this.skewMs = deps.skewMs ?? DEFAULT_REFRESH_SKEW_MS;
  }

  /**
   * Proactive path: read → refresh-if-near-expiry → re-seal → return fresh. A transient refresh failure
   * falls back to the existing (still-within-skew) token so a run is never broken by a blip; only a
   * definitive `invalid_grant`/`401` flips the connection to needs-reauth.
   */
  async resolveFresh(workspaceId: string): Promise<FreshSecretsResult> {
    const existing = this.inFlight.get(workspaceId);
    if (existing) return existing;
    const run = this.doResolveFresh(workspaceId).finally(() => this.inFlight.delete(workspaceId));
    this.inFlight.set(workspaceId, run);
    return run;
  }

  private async doResolveFresh(workspaceId: string): Promise<FreshSecretsResult> {
    const secrets = await this.deps.readSecrets(workspaceId);
    if (Object.keys(secrets).length === 0) {
      return { secrets: {}, refreshed: false, needsReauth: false };
    }
    if (connectionNeedsReauth(secrets)) {
      return { secrets: {}, refreshed: false, needsReauth: true };
    }
    if (!shouldRefreshGoogleSecrets(secrets, this.now(), this.skewMs)) {
      return { secrets, refreshed: false, needsReauth: false };
    }
    return this.performRefresh(workspaceId, secrets);
  }

  /** Force a refresh regardless of the skew window (the reactive-on-401 path). */
  private async performRefresh(workspaceId: string, secrets: Secrets): Promise<FreshSecretsResult> {
    const refreshToken = secrets[GOOGLE_REFRESH_TOKEN_KEY];
    if (!refreshToken) {
      // No grant to refresh with → the user must re-consent.
      await this.deps.writeSecrets(workspaceId, markNeedsReauthSecrets(secrets));
      return { secrets: {}, refreshed: false, needsReauth: true };
    }
    try {
      const refreshed = await this.deps.refresh(refreshToken);
      const merged = mergeRefreshedGoogleSecrets(secrets, refreshed, this.now());
      await this.deps.writeSecrets(workspaceId, merged);
      return { secrets: merged, refreshed: true, needsReauth: false };
    } catch (err) {
      if (isReauthRequiredError(err)) {
        await this.deps.writeSecrets(workspaceId, markNeedsReauthSecrets(secrets));
        return { secrets: {}, refreshed: false, needsReauth: true };
      }
      // Transient (5xx / network): keep serving the existing token — it may still be valid within skew.
      return { secrets, refreshed: false, needsReauth: false };
    }
  }

  /**
   * Reactive path: run a connector API call with refresh-on-401. The call is given the freshest access
   * token; a `401` despite that forces ONE refresh + ONE retry. A second `401` (or a dead grant) flips
   * the connection to needs-reauth. `doCall` returns the HTTP status so this wrapper can decide; its
   * `value` is passed through untouched on success.
   */
  async withTokenRefresh<T>(
    workspaceId: string,
    doCall: (accessToken: string) => Promise<{ status: number; value: T }>,
  ): Promise<{ status: number; value?: T; needsReauth: boolean }> {
    const fresh = await this.resolveFresh(workspaceId);
    const accessToken = fresh.secrets[GOOGLE_ACCESS_TOKEN_KEY];
    if (fresh.needsReauth || !accessToken) {
      return { status: 401, needsReauth: true };
    }

    const first = await doCall(accessToken);
    if (first.status !== 401) {
      return { status: first.status, value: first.value, needsReauth: false };
    }

    // 401 despite a fresh token: revoked, or our expiry clock drifted. Force one refresh + retry.
    const forced = await this.performRefresh(workspaceId, await this.deps.readSecrets(workspaceId));
    const retryToken = forced.secrets[GOOGLE_ACCESS_TOKEN_KEY];
    if (forced.needsReauth || !retryToken) {
      return { status: 401, needsReauth: true };
    }
    const second = await doCall(retryToken);
    if (second.status === 401) {
      // Still rejected after a genuine refresh → the grant is dead; require re-consent.
      await this.deps.writeSecrets(workspaceId, markNeedsReauthSecrets(forced.secrets));
      return { status: 401, needsReauth: true };
    }
    return { status: second.status, value: second.value, needsReauth: false };
  }
}
