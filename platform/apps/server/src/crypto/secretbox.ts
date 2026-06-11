import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * At-rest encryption for the per-tenant credentials vault (#68, ADR-0068).
 *
 * The owner's Claude subscription token is sensitive, so we encrypt it before it touches the DB with
 * AES-256-GCM (authenticated: a tampered ciphertext fails to open). The key comes from
 * `AGENT_CREDENTIALS_ENC_KEY`. When no key is configured (dev/CI), `seal`/`open` are a transparent
 * pass-through — so a fresh clone needs no key, while a real deployment sets one and the token is
 * encrypted on disk. Dependency-free (node:crypto only), mirroring the #98 signed-webhook helpers.
 */

const ENC_PREFIX = "enc:";
const RAW_PREFIX = "raw:";
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;

/** Read the encryption key from env, treating blank as "no key" (pass-through). */
export function loadEncKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.AGENT_CREDENTIALS_ENC_KEY;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Derive a 32-byte AES key from the configured key material (hex, base64, or any string). */
function deriveKey(material: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(material)) return Buffer.from(material, "hex");
  const b64 = Buffer.from(material, "base64");
  if (b64.length === 32) return b64;
  // Any other string: hash to a stable 32-byte key so an operator can use a passphrase.
  return createHash("sha256").update(material).digest();
}

/** Encrypt `value`. With no key, returns a marked pass-through so `open` can round-trip it. */
export function seal(value: string, key: string | null): string {
  if (!key) return RAW_PREFIX + value;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/** Decrypt a value produced by {@link seal}. Throws on a tampered ciphertext (GCM auth failure). */
export function open(sealed: string, key: string | null): string {
  if (sealed.startsWith(RAW_PREFIX)) return sealed.slice(RAW_PREFIX.length);
  if (!sealed.startsWith(ENC_PREFIX)) return sealed; // legacy/plaintext row
  if (!key) throw new Error("encrypted credential present but no AGENT_CREDENTIALS_ENC_KEY configured");
  const blob = Buffer.from(sealed.slice(ENC_PREFIX.length), "base64");
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(key), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * A stable, non-reversible fingerprint of a token — safe to persist and show in the UI as proof a
 * credential is connected without ever exposing the token itself.
 */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/** Constant-time equality for fingerprints (avoids leaking via timing where it's compared). */
export function fingerprintEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
