import { describe, it, expect } from "vitest";
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  buildListUnsubscribeHeaders,
  decideOneClickUnsubscribe,
} from "../../src/email/one-click-unsubscribe.js";

const SECRET = "unsub-secret-xyz";

describe("signUnsubscribeToken / verifyUnsubscribeToken (HMAC, no PII)", () => {
  it("round-trips: a token signed for a recipient verifies for that recipient", () => {
    const token = signUnsubscribeToken("Alice@Example.com", SECRET);
    expect(token).toMatch(/^[0-9a-f]+$/);
    expect(verifyUnsubscribeToken("alice@example.com", token, SECRET)).toBe(true);
  });

  it("is case/whitespace insensitive on the recipient (normalized before signing)", () => {
    const token = signUnsubscribeToken("  alice@example.com ", SECRET);
    expect(verifyUnsubscribeToken("ALICE@EXAMPLE.COM", token, SECRET)).toBe(true);
  });

  it("a token for one recipient does NOT verify for another (binding)", () => {
    const token = signUnsubscribeToken("alice@example.com", SECRET);
    expect(verifyUnsubscribeToken("bob@example.com", token, SECRET)).toBe(false);
  });

  it("a forged/garbage token does not verify (constant-time, length-safe)", () => {
    expect(verifyUnsubscribeToken("alice@example.com", "deadbeef", SECRET)).toBe(false);
    expect(verifyUnsubscribeToken("alice@example.com", "", SECRET)).toBe(false);
  });

  it("verification fails closed when no secret is configured", () => {
    const token = signUnsubscribeToken("alice@example.com", SECRET);
    expect(verifyUnsubscribeToken("alice@example.com", token, "")).toBe(false);
  });

  it("signing without a secret is a misconfiguration and throws", () => {
    expect(() => signUnsubscribeToken("alice@example.com", "")).toThrow();
  });
});

describe("buildListUnsubscribeHeaders (RFC 8058 one-click)", () => {
  it("emits a List-Unsubscribe with the https form and the one-click POST header", () => {
    const h = buildListUnsubscribeHeaders({ httpsUrl: "https://ipop.ai/email/unsubscribe/ws1?u=abc" });
    expect(h["List-Unsubscribe"]).toBe("<https://ipop.ai/email/unsubscribe/ws1?u=abc>");
    expect(h["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("includes the mailto form alongside the https form when provided", () => {
    const h = buildListUnsubscribeHeaders({
      httpsUrl: "https://ipop.ai/email/unsubscribe/ws1?u=abc",
      mailto: "unsubscribe@ipop.ai",
    });
    expect(h["List-Unsubscribe"]).toBe(
      "<https://ipop.ai/email/unsubscribe/ws1?u=abc>, <mailto:unsubscribe@ipop.ai>",
    );
  });
});

describe("decideOneClickUnsubscribe (POST → suppression)", () => {
  it("suppresses with reason 'unsubscribe' when the token verifies", () => {
    const token = signUnsubscribeToken("alice@example.com", SECRET);
    const d = decideOneClickUnsubscribe({ recipient: "Alice@Example.com", token, secret: SECRET });
    expect(d.ok).toBe(true);
    expect(d.recipient).toBe("alice@example.com");
    expect(d.reason).toBe("unsubscribe");
  });

  it("refuses (no suppression target) when the token is invalid", () => {
    const d = decideOneClickUnsubscribe({ recipient: "alice@example.com", token: "bad", secret: SECRET });
    expect(d.ok).toBe(false);
    expect(d.recipient).toBeNull();
  });

  it("refuses on an empty recipient", () => {
    const token = signUnsubscribeToken("alice@example.com", SECRET);
    const d = decideOneClickUnsubscribe({ recipient: "   ", token, secret: SECRET });
    expect(d.ok).toBe(false);
    expect(d.recipient).toBeNull();
  });
});
