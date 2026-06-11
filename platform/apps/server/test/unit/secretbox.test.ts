import { describe, it, expect } from "vitest";
import { seal, open, tokenFingerprint, loadEncKey } from "../../src/crypto/secretbox.js";

const KEY = "0".repeat(64); // 32 bytes as hex

describe("secretbox (#68 — at-rest encryption for the credentials vault)", () => {
  it("round-trips a value through seal → open with a key", () => {
    const sealed = seal("oauth-token-abc", KEY);
    expect(sealed).not.toContain("oauth-token-abc"); // ciphertext must not leak the plaintext
    expect(open(sealed, KEY)).toBe("oauth-token-abc");
  });

  it("produces different ciphertext each time (random nonce) but opens to the same value", () => {
    const a = seal("same", KEY);
    const b = seal("same", KEY);
    expect(a).not.toBe(b);
    expect(open(a, KEY)).toBe("same");
    expect(open(b, KEY)).toBe("same");
  });

  it("passes through transparently when no key is configured (dev/CI)", () => {
    const sealed = seal("plain-token", null);
    expect(open(sealed, null)).toBe("plain-token");
  });

  it("fails closed: opening tampered ciphertext throws (AES-GCM auth)", () => {
    const sealed = seal("secret", KEY);
    const tampered = sealed.slice(0, -2) + (sealed.endsWith("a") ? "bb" : "aa");
    expect(() => open(tampered, KEY)).toThrow();
  });

  it("fingerprint is stable, non-reversible, and short (safe for the UI 'connected' state)", () => {
    const fp = tokenFingerprint("oauth-token-abc");
    expect(fp).toBe(tokenFingerprint("oauth-token-abc"));
    expect(fp).not.toContain("oauth-token-abc");
    expect(fp.length).toBeLessThanOrEqual(16);
    expect(tokenFingerprint("different")).not.toBe(fp);
  });

  it("loadEncKey reads AGENT_CREDENTIALS_ENC_KEY, treating blank as no key", () => {
    expect(loadEncKey({ AGENT_CREDENTIALS_ENC_KEY: KEY })).toBe(KEY);
    expect(loadEncKey({ AGENT_CREDENTIALS_ENC_KEY: "  " })).toBeNull();
    expect(loadEncKey({})).toBeNull();
  });
});
