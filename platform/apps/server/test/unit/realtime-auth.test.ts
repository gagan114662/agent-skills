import { describe, it, expect } from "vitest";
import { extractWsCredentials } from "../../src/realtime/auth.js";

describe("extractWsCredentials", () => {
  it("reads an agent Bearer token from the Authorization header", () => {
    const creds = extractWsCredentials({
      headers: { authorization: "Bearer reload_abc" },
      url: "/ws",
    });
    expect(creds.authorization).toBe("Bearer reload_abc");
    expect(creds.sessionToken).toBeUndefined();
  });

  it("falls back to ?access_token= for browser clients", () => {
    const creds = extractWsCredentials({ headers: {}, url: "/ws?access_token=reload_xyz" });
    expect(creds.authorization).toBe("Bearer reload_xyz");
  });

  it("reads a human session token from the rid cookie", () => {
    const creds = extractWsCredentials({
      headers: { cookie: "other=1; rid=sess123; foo=bar" },
      url: "/ws",
    });
    expect(creds.sessionToken).toBe("sess123");
    expect(creds.authorization).toBeUndefined();
  });

  it("falls back to ?rid= when no cookie is present", () => {
    const creds = extractWsCredentials({ headers: {}, url: "/ws?rid=sess456" });
    expect(creds.sessionToken).toBe("sess456");
  });

  it("prefers the header/cookie over query params", () => {
    const creds = extractWsCredentials({
      headers: { authorization: "Bearer reload_header", cookie: "rid=cookieSess" },
      url: "/ws?access_token=reload_query&rid=querySess",
    });
    expect(creds.authorization).toBe("Bearer reload_header");
    expect(creds.sessionToken).toBe("cookieSess");
  });

  it("returns empty credentials for an anonymous upgrade", () => {
    const creds = extractWsCredentials({ headers: {}, url: "/ws" });
    expect(creds.authorization).toBeUndefined();
    expect(creds.sessionToken).toBeUndefined();
  });
});
