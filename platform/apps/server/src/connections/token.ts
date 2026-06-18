/**
 * The capability-token CODEC (#336, ADR-0336 — extends the #258 connect-once seam). This is the Vercel
 * "Connect" credential model applied to ipop's fleet: instead of an agent holding a standing provider secret,
 * it requests a **capability token per action** — scoped to one connection + one capability + one verb,
 * SHORT-LIVED (a TTL), DELEGATED (it carries the user→agent→service chain), and traceable. The raw provider
 * secret is never stored in or derived from the token: the token is an HMAC-signed bearer claim the seam
 * mints from an existing connection grant; the real credential stays sealed in the #192 vault, unread by the
 * agent.
 *
 * We HMAC a compact claims payload with a server secret (mirrors `state.ts`): tamper-evident and
 * self-expiring, no DB row on the hot path. Honoring the premortem (#200):
 *  - §4 (irreversible actions): the `verb` + `approvalRequestId` claims encode that a `write` (send/post/
 *    spend) token is pre-committed behind a #13 approval — the codec carries the proof; `token-mint.ts`
 *    enforces it.
 *  - §6 (injection defense): a token's `capability`/`verb`/scope come ONLY from the signed claims minted off
 *    the connection grant. {@link verifyCapabilityToken} re-derives them from the verified body and nothing
 *    else, so a provider/MCP response can never widen what a token authorizes.
 *
 * Pure (the secret + clock are injected) so it unit-tests deterministically.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** What a capability token authorizes a single action to do. `read` is reversible; `write` is an outward
 * mutation (send/post/spend) that must be pre-committed behind a #13 approval. */
export type TokenVerb = "read" | "write";

export function isTokenVerb(value: unknown): value is TokenVerb {
  return value === "read" || value === "write";
}

/** The delegation chain a token carries: the user who holds the grant → the agent it is delegated to. */
export interface DelegationChain {
  /** The member/user who holds the underlying connection grant — the delegation ROOT (user→…). */
  memberId: string;
  /** The agent the grant is delegated TO for this single action (…→agent→service). */
  agentId: string;
}

/** The signed claims of a capability token. Everything the seam authorizes is here and nowhere else. */
export interface CapabilityTokenClaims {
  workspaceId: string;
  /** The connection (and #192 vault `service_key`) this token acts through — the SERVICE in the chain. */
  connectionId: string;
  /** The single capability authorized (e.g. `search_console`, `post_social`) — never a set, never widenable. */
  capability: string;
  /** `read` (reversible, autonomous) | `write` (outward, pre-committed behind #13). */
  verb: TokenVerb;
  /** The user→agent delegation chain. */
  delegation: DelegationChain;
  /** The #13 approval that pre-commits an irreversible `write`; null for an autonomous `read`. */
  approvalRequestId: string | null;
  /** Idempotency / replay id — a re-mint with the same jti returns the SAME token (see token-service.ts). */
  jti: string;
  /** Issued-at, ms epoch. */
  iat: number;
  /** Expiry, ms epoch — the short-lived TTL deadline. */
  exp: number;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** Encode + sign a capability token. The claims (incl. `iat`/`exp`) are supplied by the minting service. */
export function signCapabilityToken(claims: CapabilityTokenClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

/** True iff the token's TTL deadline has passed (the short-lived guarantee). Pure + total. */
export function isCapabilityTokenExpired(claims: CapabilityTokenClaims, now: number): boolean {
  return claims.exp <= now;
}

/**
 * Verify + decode a capability token: returns the claims when the signature matches AND the token is
 * unexpired AND not future-dated; null otherwise (tampered, malformed, wrong secret, expired). The returned
 * claims are the ONLY authority a holder gets — a caller reads `capability`/`verb` from here, never from a
 * provider response, so an injected/poisoned read can never widen the token's scope (premortem §6).
 */
export function verifyCapabilityToken(
  token: string,
  secret: string,
  opts: { now?: number } = {},
): CapabilityTokenClaims | null {
  const now = opts.now ?? Date.now();
  if (typeof token !== "string" || !token.includes(".")) return null;
  const dot = token.indexOf(".");
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(sign(body, secret));
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  // A correctly-signed body can still decode to a primitive / array / null — guard BEFORE property access.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  const delegation = p.delegation;
  if (
    typeof p.workspaceId !== "string" ||
    typeof p.connectionId !== "string" ||
    typeof p.capability !== "string" ||
    !isTokenVerb(p.verb) ||
    typeof p.jti !== "string" ||
    typeof delegation !== "object" ||
    delegation === null ||
    typeof (delegation as Record<string, unknown>).memberId !== "string" ||
    typeof (delegation as Record<string, unknown>).agentId !== "string" ||
    (p.approvalRequestId !== null && typeof p.approvalRequestId !== "string") ||
    typeof p.iat !== "number" ||
    typeof p.exp !== "number"
  ) {
    return null;
  }
  // Expired or future-dated (clock-skew tolerance) tokens are rejected — the short-lived guarantee.
  if (p.exp <= now || p.iat > now + 60_000) return null;
  const d = delegation as Record<string, unknown>;
  return {
    workspaceId: p.workspaceId,
    connectionId: p.connectionId,
    capability: p.capability,
    verb: p.verb,
    delegation: { memberId: d.memberId as string, agentId: d.agentId as string },
    approvalRequestId: (p.approvalRequestId as string | null) ?? null,
    jti: p.jti,
    iat: p.iat,
    exp: p.exp,
  };
}
