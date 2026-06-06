import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  generateAgentToken,
  generateSessionToken,
  hashToken,
  AGENT_TOKEN_PREFIX,
} from "../../src/auth/secrets.js";

describe("password hashing (argon2id)", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("produces a different hash each time (random salt)", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("rejects malformed stored values", async () => {
    expect(await verifyPassword("x", "not-a-valid-hash")).toBe(false);
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
