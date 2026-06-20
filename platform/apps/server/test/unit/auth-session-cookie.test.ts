import { describe, it, expect } from "vitest";
import { resolveSessionCookieOptions } from "../../src/routes/auth.js";

/**
 * #418 — The SPA on https://ipop.ai bootstraps by calling GET /me on https://api.ipop.ai.
 * That is a cross-site credentialed fetch, so the `rid` session cookie is only attached when
 * it was set with `SameSite=None; Secure`. A `Lax` cookie is silently dropped cross-site, so
 * bootstrap() 401s and AuthGate redirects to /start. These tests pin the cookie attributes to
 * the deployment shape (cross-site when RELOAD_WEB_ORIGIN names a separate web origin).
 */
describe("resolveSessionCookieOptions (#418 cross-site session cookie)", () => {
  it("uses SameSite=None; Secure when a cross-origin web origin is configured", () => {
    const opts = resolveSessionCookieOptions({
      RELOAD_WEB_ORIGIN: "https://ipop.ai,https://www.ipop.ai",
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);
    // None REQUIRES Secure or the browser rejects the cookie entirely.
    expect(opts.sameSite).toBe("none");
    expect(opts.secure).toBe(true);
  });

  it("forces Secure even in non-production when cross-site (None is invalid without Secure)", () => {
    const opts = resolveSessionCookieOptions({
      RELOAD_WEB_ORIGIN: "https://ipop.ai",
    } as NodeJS.ProcessEnv);
    expect(opts.sameSite).toBe("none");
    expect(opts.secure).toBe(true);
  });

  it("keeps SameSite=Lax for same-origin / local dev (no web origin configured)", () => {
    const opts = resolveSessionCookieOptions({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(opts.sameSite).toBe("lax");
    expect(opts.secure).toBe(true);
  });

  it("keeps Lax + insecure for local http dev so the cookie still sets over http", () => {
    const opts = resolveSessionCookieOptions({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
    expect(opts.sameSite).toBe("lax");
    expect(opts.secure).toBe(false);
  });

  it("ignores a blank/whitespace RELOAD_WEB_ORIGIN (treated as same-origin)", () => {
    const opts = resolveSessionCookieOptions({
      RELOAD_WEB_ORIGIN: "  ,  ",
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);
    expect(opts.sameSite).toBe("lax");
  });
});
