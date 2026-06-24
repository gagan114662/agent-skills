import { describe, it, expect } from "vitest";
import {
  OAUTH_STATE_DEFAULT_KEY_ID,
  signState,
  verifyState,
  newStateNonce,
  loadStateSecret,
  loadStateKeyId,
} from "../../src/auth/oauth-state.js";

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

  it("signed states carry a key id for rotation without exposing it in the verified payload", () => {
    const state = signState({ domain: "acme.com", nonce: "n" }, SECRET, 1000, "oauth-state:v2");
    const [body] = state.split(".");
    const raw = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as { kid?: string };

    expect(raw.kid).toBe("oauth-state:v2");
    expect(verifyState(state, SECRET, { now: 1000 })).toEqual({ domain: "acme.com", nonce: "n" });
  });

  it("loadStateSecret prefers explicit secret, then enc key, then an ephemeral non-production secret", () => {
    expect(loadStateSecret({ GOOGLE_OAUTH_STATE_SECRET: "a" } as NodeJS.ProcessEnv)).toBe("a");
    expect(loadStateSecret({ AGENT_CREDENTIALS_ENC_KEY: "b" } as NodeJS.ProcessEnv)).toBe("b");
    const fallback = loadStateSecret({} as NodeJS.ProcessEnv);
    expect(fallback).toMatch(/^dev-oauth-state-/);
    expect(fallback).not.toContain("ipop");
  });

  it("loadStateSecret fails closed in production without a configured secret", () => {
    expect(() => loadStateSecret({ RELOAD_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(
      /GOOGLE_OAUTH_STATE_SECRET/,
    );
  });

  it("loadStateKeyId prefers explicit ids and otherwise returns the default non-secret id", () => {
    expect(loadStateKeyId({ GOOGLE_OAUTH_STATE_KEY_ID: "oauth-k2" } as NodeJS.ProcessEnv)).toBe("oauth-k2");
    expect(loadStateKeyId({ AGENT_CREDENTIALS_KEY_ID: "enc-k3" } as NodeJS.ProcessEnv)).toBe("enc-k3");
    expect(loadStateKeyId({} as NodeJS.ProcessEnv)).toBe(OAUTH_STATE_DEFAULT_KEY_ID);
  });
});
