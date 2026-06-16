import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Stateless OAuth `state` for the #260 Google flow. The `state` round-trips through Google's consent
 * screen and must (a) be unguessable per-flow (CSRF) and (b) carry the domain the user typed BEFORE the
 * redirect, so the callback knows which site to bootstrap without a server-side session table.
 *
 * We HMAC a compact `{domain, nonce, ts}` payload with a server secret: tamper-evident and self-expiring,
 * no DB row. The nonce makes each flow's state unique; `ts` bounds replay. Pure (the secret + clock are
 * injected) so it unit-tests deterministically.
 */

export interface OAuthStatePayload {
  domain: string;
  nonce: string;
}

interface SignedState extends OAuthStatePayload {
  ts: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** A fresh random nonce for a new auth flow. */
export function newStateNonce(): string {
  return randomBytes(16).toString("base64url");
}

/** Encode + sign an OAuth state. `now` defaults to the wall clock (injected in tests). */
export function signState(
  payload: OAuthStatePayload,
  secret: string,
  now: number = Date.now(),
): string {
  const signed: SignedState = { domain: payload.domain, nonce: payload.nonce, ts: now };
  const body = b64url(Buffer.from(JSON.stringify(signed), "utf8"));
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify + decode an OAuth state. Returns the payload when the signature matches and the state is younger
 * than `maxAgeMs`; null otherwise (tampered, malformed, wrong secret, or expired).
 */
export function verifyState(
  state: string,
  secret: string,
  opts: { maxAgeMs?: number; now?: number } = {},
): OAuthStatePayload | null {
  const maxAgeMs = opts.maxAgeMs ?? 10 * 60 * 1000; // a consent screen is short-lived
  const now = opts.now ?? Date.now();
  if (typeof state !== "string" || !state.includes(".")) return null;
  const dot = state.indexOf(".");
  const body = state.slice(0, dot);
  const mac = state.slice(dot + 1);
  const expected = sign(body, secret);
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return null;
  let parsed: SignedState;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SignedState;
  } catch {
    return null;
  }
  if (typeof parsed.domain !== "string" || typeof parsed.nonce !== "string") return null;
  if (typeof parsed.ts !== "number" || now - parsed.ts > maxAgeMs || parsed.ts > now + 60_000) {
    return null;
  }
  return { domain: parsed.domain, nonce: parsed.nonce };
}

/**
 * The secret used to sign OAuth state. Reuses the deployment's credential encryption key (already required
 * for the #192 vault in prod, and stable across instances), falling back to a fixed dev secret so the flow
 * works locally. Read live each call (env can change between calls; mirrors `loadConfig`).
 */
export function loadStateSecret(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.GOOGLE_OAUTH_STATE_SECRET?.trim() || env.AGENT_CREDENTIALS_ENC_KEY?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : "ipop-dev-oauth-state-secret";
}
