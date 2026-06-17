import { describe, it, expect } from "vitest";
import { signState, verifyState, newStateNonce, loadStateSecret } from "../../src/auth/oauth-state.js";

const SECRET = "test-secret-key";

describe("oauth-state (#260 CSRF + domain carrier)", () => {
  it("round-trips the domain + nonce through a signed state", () => {
    const nonce = newStateNonce();
    const state = signState({ domain: "acme.com", nonce }, SECRET, 1000);
    expect(verifyState(state, SECRET, { now: 1000 })).toEqual({ domain: "acme.com", nonce });
  });

  it("rejects a tampered payload", () => {
    const state = signState({ domain: "acme.com", nonce: "n" }, SECRET, 1000);
    const [body, mac] = state.split(".");
    const forged = `${Buffer.from('{"domain":"evil.com","nonce":"n","ts":1000}').toString("base64url")}.${mac}`;
    expect(verifyState(forged, SECRET, { now: 1000 })).toBeNull();
    expect(verifyState(`${body}.deadbeef`, SECRET, { now: 1000 })).toBeNull();
  });

  it("rejects a state signed with a different secret", () => {
    const state = signState({ domain: "acme.com", nonce: "n" }, SECRET, 1000);
    expect(verifyState(state, "other-secret", { now: 1000 })).toBeNull();
  });

  it("rejects an expired state and a future-dated state", () => {
    const state = signState({ domain: "acme.com", nonce: "n" }, SECRET, 1000);
    expect(verifyState(state, SECRET, { now: 1000 + 11 * 60 * 1000 })).toBeNull(); // > 10m
    const future = signState({ domain: "acme.com", nonce: "n" }, SECRET, 10_000_000);
    expect(verifyState(future, SECRET, { now: 1000 })).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyState("", SECRET)).toBeNull();
    expect(verifyState("nodot", SECRET)).toBeNull();
  });

  it("#300 round-trips the deferred-SEO intent, and omits it for a plain signup state", () => {
    const seo = signState({ domain: "acme.com", nonce: "n", intent: "seo" }, SECRET, 1000);
    expect(verifyState(seo, SECRET, { now: 1000 })).toEqual({ domain: "acme.com", nonce: "n", intent: "seo" });
    // A signup state (intent absent or "signup") stays exactly {domain, nonce} — #260 byte-for-byte.
    const signup = signState({ domain: "acme.com", nonce: "n", intent: "signup" }, SECRET, 1000);
    expect(verifyState(signup, SECRET, { now: 1000 })).toEqual({ domain: "acme.com", nonce: "n" });
  });

  it("loadStateSecret prefers explicit secret, then enc key, then a dev fallback", () => {
    expect(loadStateSecret({ GOOGLE_OAUTH_STATE_SECRET: "a" } as NodeJS.ProcessEnv)).toBe("a");
    expect(loadStateSecret({ AGENT_CREDENTIALS_ENC_KEY: "b" } as NodeJS.ProcessEnv)).toBe("b");
    expect(loadStateSecret({} as NodeJS.ProcessEnv)).toBe("ipop-dev-oauth-state-secret");
  });
});
