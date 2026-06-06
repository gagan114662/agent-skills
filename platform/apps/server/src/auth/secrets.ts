import { randomBytes, scryptSync, createHash, timingSafeEqual } from "node:crypto";

export const AGENT_TOKEN_PREFIX = "rld_agt_";

/** Opaque agent token (`rld_agt_<32B base64url>`) plus its SHA-256 hash for storage. */
export function generateAgentToken(): { raw: string; hash: string } {
  const raw = AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

/** Opaque session token plus its SHA-256 hash for storage. */
export function generateSessionToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

/** SHA-256 of an opaque token. We store/compare only the hash; the raw is shown once. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Password hashing via Node's built-in scrypt (memory-hard, zero native deps — ADR-0003).
 * Format: `scrypt$<saltHex>$<hashHex>`.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  const derived = scryptSync(password, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
