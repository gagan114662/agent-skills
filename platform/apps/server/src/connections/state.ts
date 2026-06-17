/**
 * Stateless OAuth `state` for the connect-once seam (#258 Stage 2, ADR-0258). The `state` round-trips
 * through the provider's consent screen and must (a) be unguessable per-flow (CSRF) and (b) carry which
 * WORKSPACE and which CONNECTION the flow is for, so the callback seals the resulting credential into the
 * right tenant's vault under the right `service_key` — without a server-side session table.
 *
 * We HMAC a compact `{workspaceId, connectionId, nonce, ts}` payload with a server secret: tamper-evident
 * and self-expiring, no DB row. Binding `workspaceId` is the anti-tenant-cross rule (a callback can never be
 * replayed against a different tenant); `connectionId` binds the consent to the exact connector the user
 * started. Mirrors the #260 `oauth-state` / #262 `claude-connect` state, generalised to any connector. Pure
 * (the secret + clock are injected) so it unit-tests deterministically.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface ConnectStatePayload {
  workspaceId: string;
  /** The connection descriptor id the consent is for (e.g. `google`, `x`, `linkedin`, `website`). */
  connectionId: string;
  nonce: string;
}

interface SignedConnectState extends ConnectStatePayload {
  ts: number;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** Encode + sign a connect state. `now` is injected so it unit-tests deterministically. */
export function signConnectState(
  payload: ConnectStatePayload,
  secret: string,
  now: number = Date.now(),
): string {
  const signed: SignedConnectState = {
    workspaceId: payload.workspaceId,
    connectionId: payload.connectionId,
    nonce: payload.nonce,
    ts: now,
  };
  const body = Buffer.from(JSON.stringify(signed), "utf8").toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify + decode a connect state: returns the payload when the signature matches and the state is younger
 * than `maxAgeMs`; null otherwise (tampered, malformed, wrong secret, expired, or future-dated).
 */
export function verifyConnectState(
  state: string,
  secret: string,
  opts: { maxAgeMs?: number; now?: number } = {},
): ConnectStatePayload | null {
  const maxAgeMs = opts.maxAgeMs ?? 10 * 60 * 1000; // a consent screen is short-lived
  const now = opts.now ?? Date.now();
  if (typeof state !== "string" || !state.includes(".")) return null;
  const dot = state.indexOf(".");
  const body = state.slice(0, dot);
  const mac = state.slice(dot + 1);
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(sign(body, secret));
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return null;
  let parsed: SignedConnectState;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SignedConnectState;
  } catch {
    return null;
  }
  // A correctly-signed body can still decode to null / a primitive / an array — guard BEFORE any property
  // access so an attacker-crafted payload returns null instead of throwing (crashing the callback).
  if (parsed === null || typeof parsed !== "object") return null;
  if (
    typeof parsed.workspaceId !== "string" ||
    typeof parsed.connectionId !== "string" ||
    typeof parsed.nonce !== "string"
  ) {
    return null;
  }
  if (typeof parsed.ts !== "number" || now - parsed.ts > maxAgeMs || parsed.ts > now + 60_000) {
    return null;
  }
  return {
    workspaceId: parsed.workspaceId,
    connectionId: parsed.connectionId,
    nonce: parsed.nonce,
  };
}
