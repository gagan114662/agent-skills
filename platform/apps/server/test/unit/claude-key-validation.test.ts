import { describe, it, expect, vi } from "vitest";
import {
  validateClaudeKeyFormat,
  isWellFormedClaudeKey,
  assertClaudeKeyFormat,
  ClaudeKeyInvalidError,
  FormatOnlyClaudeKeyChecker,
  LiveClaudeKeyChecker,
  isLiveKeyValidationEnabled,
  createClaudeKeyChecker,
  type FetchLike,
} from "../../src/auth/claude-key-validation.js";

describe("validateClaudeKeyFormat (#659 — catch a mangled/blank key up front)", () => {
  it("accepts plausible opaque tokens (lenient on length/charset — never guesses a real token bad)", () => {
    // The integration API test connects with the short literal "tok"; it must NOT be rejected.
    for (const tok of ["tok", "ac_x", "sk-ant-oat-abc", "oauth-tok", "x".repeat(200)]) {
      expect(validateClaudeKeyFormat(tok)).toEqual({ valid: true, checkedLive: false });
      expect(isWellFormedClaudeKey(tok)).toBe(true);
    }
  });

  it("rejects an empty / whitespace-only token", () => {
    expect(validateClaudeKeyFormat("").valid).toBe(false);
    expect(validateClaudeKeyFormat("   ").valid).toBe(false);
    expect(validateClaudeKeyFormat("   ").reason).toMatch(/empty/);
  });

  it("rejects a token with an embedded space (a sloppy copy/paste)", () => {
    const r = validateClaudeKeyFormat("sk-ant oat-abc");
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/spaces/);
  });

  it("rejects a token with an embedded newline / tab / control char", () => {
    expect(validateClaudeKeyFormat("sk-ant\noat").valid).toBe(false);
    expect(validateClaudeKeyFormat("sk-ant\toat").valid).toBe(false);
    expect(validateClaudeKeyFormat("sk-ant\u0007oat").valid).toBe(false);
    expect(validateClaudeKeyFormat("sk-ant\u0007oat").reason).toMatch(/control/);
  });
});

describe("assertClaudeKeyFormat (save-path helper)", () => {
  it("is a no-op for a well-formed token", () => {
    expect(() => assertClaudeKeyFormat("sk-ant-oat-abc")).not.toThrow();
  });
  it("throws a credential-free ClaudeKeyInvalidError for a malformed token", () => {
    try {
      assertClaudeKeyFormat("sk-ant oat");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeKeyInvalidError);
      // The error must never echo the token value.
      expect((err as Error).message).not.toContain("sk-ant oat");
    }
  });
});

describe("FormatOnlyClaudeKeyChecker (the default — never touches the network)", () => {
  it("returns the format verdict, checkedLive=false", async () => {
    const checker = new FormatOnlyClaudeKeyChecker();
    expect(await checker.check("sk-ant-oat-abc")).toEqual({ valid: true, checkedLive: false });
    expect((await checker.check("bad tok")).valid).toBe(false);
  });
});

describe("LiveClaudeKeyChecker (#659 — env-gated live revocation probe, fails open)", () => {
  const ok = (status: number): FetchLike => async () => ({ status });
  const calls = (status: number): { fetch: FetchLike; count: () => number } => {
    let n = 0;
    return { fetch: async () => ((n += 1), { status }), count: () => n };
  };

  it("rejects a token the account 401s / 403s on (the genuinely-invalid case)", async () => {
    expect((await new LiveClaudeKeyChecker(ok(401)).check("sk-ant-oat-x")).valid).toBe(false);
    const r = await new LiveClaudeKeyChecker(ok(403)).check("sk-ant-oat-x");
    expect(r).toEqual({
      valid: false,
      reason: expect.stringMatching(/reconnect your Claude/),
      checkedLive: true,
    });
  });

  it("accepts a token the account 200s on", async () => {
    expect(await new LiveClaudeKeyChecker(ok(200)).check("sk-ant-oat-x")).toEqual({
      valid: true,
      checkedLive: true,
    });
  });

  it("FAILS OPEN on inconclusive answers (429 rate-limit, 5xx) — never blocks a legit key on a blip", async () => {
    expect((await new LiveClaudeKeyChecker(ok(429)).check("sk-ant-oat-x")).valid).toBe(true);
    expect((await new LiveClaudeKeyChecker(ok(503)).check("sk-ant-oat-x")).valid).toBe(true);
  });

  it("FAILS OPEN on a thrown network error / timeout", async () => {
    const throwing: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    expect((await new LiveClaudeKeyChecker(throwing).check("sk-ant-oat-x")).valid).toBe(true);
  });

  it("short-circuits a malformed token WITHOUT calling the network", async () => {
    const c = calls(401);
    const checker = new LiveClaudeKeyChecker(c.fetch);
    expect((await checker.check("bad tok")).valid).toBe(false);
    expect(c.count()).toBe(0);
  });
});

describe("createClaudeKeyChecker / isLiveKeyValidationEnabled (DEFAULT-OFF)", () => {
  it("is format-only by default", async () => {
    expect(isLiveKeyValidationEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    const checker = createClaudeKeyChecker({} as NodeJS.ProcessEnv, async () => ({ status: 401 }));
    // Live would reject; default must NOT call it → a well-formed token passes.
    expect((await checker.check("sk-ant-oat-x")).checkedLive).toBe(false);
  });

  it("uses the live probe when CLAUDE_KEY_VALIDATION=live and a fetch is available", async () => {
    expect(isLiveKeyValidationEnabled({ CLAUDE_KEY_VALIDATION: "live" } as NodeJS.ProcessEnv)).toBe(true);
    const checker = createClaudeKeyChecker(
      { CLAUDE_KEY_VALIDATION: "live" } as NodeJS.ProcessEnv,
      async () => ({ status: 401 }),
    );
    const r = await checker.check("sk-ant-oat-x");
    expect(r.valid).toBe(false);
    expect(r.checkedLive).toBe(true);
  });

  it("falls back to format-only when live is requested but no fetch exists in the runtime", async () => {
    vi.stubGlobal("fetch", undefined);
    try {
      const checker = createClaudeKeyChecker({ CLAUDE_KEY_VALIDATION: "live" } as NodeJS.ProcessEnv);
      expect((await checker.check("sk-ant-oat-x")).checkedLive).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
