import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  generateAgentToken,
  generateSessionToken,
  hashToken,
  AGENT_TOKEN_PREFIX,
} from "../../src/auth/secrets.js";

describe("password hashing (scrypt)", () => {
  it("verifies a correct password and rejects a wrong one", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
  });

  it("produces a different salt/hash each time", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects malformed stored values", () => {
    expect(verifyPassword("x", "not-a-valid-hash")).toBe(false);
  });
});

describe("opaque tokens", () => {
  it("agent tokens carry the prefix and hash deterministically", () => {
    const { raw, hash } = generateAgentToken();
    expect(raw.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(hash).toBe(hashToken(raw));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("session tokens are random and hash deterministically", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).toBe(hashToken(a.raw));
  });
});
