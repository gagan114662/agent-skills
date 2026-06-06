import { randomBytes, createHash } from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

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
 * Password hashing via argon2id (OWASP-recommended; ADR-0003). Returns a PHC string
 * (`$argon2id$...`). `@node-rs/argon2` ships prebuilt binaries for CI/dev platforms.
 */
export function hashPassword(password: string): Promise<string> {
  return argon2Hash(password); // @node-rs/argon2 defaults to argon2id
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    return await argon2Verify(stored, password);
  } catch {
    return false;
  }
}
