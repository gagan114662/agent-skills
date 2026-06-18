import { describe, it, expect } from "vitest";
import {
  deriveClaudeConnectionHealth,
  type ClaudeConnectionHealthInput,
} from "../../src/auth/claude-connect-health.js";

/**
 * #365 — connection-health derivation. Pure + total + fail-closed: the owner sees connected / not
 * connected / token expired purely from vault facts, with no live call and no token access.
 */
const base: ClaudeConnectionHealthInput = {
  connected: true,
  connectedAt: new Date("2026-06-18T10:00:00Z"),
  lastAuthFailureAt: null,
};

describe("deriveClaudeConnectionHealth (#365)", () => {
  it("reports not_connected (with an actionable reason) when no credential is in the vault", () => {
    const r = deriveClaudeConnectionHealth({ connected: false, connectedAt: null, lastAuthFailureAt: null });
    expect(r.state).toBe("not_connected");
    expect(r.reason).toMatch(/connect/i);
  });

  it("stays not_connected even if a stale failure timestamp lingers (no row = nothing to expire)", () => {
    // A disconnect deletes the row; this guards the fail-closed shape if a caller passes inconsistent input.
    const r = deriveClaudeConnectionHealth({
      connected: false,
      connectedAt: null,
      lastAuthFailureAt: new Date("2026-06-18T11:00:00Z"),
    });
    expect(r.state).toBe("not_connected");
  });

  it("reports connected with no reason when a credential is present and no failure was observed", () => {
    const r = deriveClaudeConnectionHealth(base);
    expect(r.state).toBe("connected");
    expect(r.reason).toBeNull();
  });

  it("reports expired when a failure was observed AFTER the last (re)connect", () => {
    const r = deriveClaudeConnectionHealth({
      ...base,
      lastAuthFailureAt: new Date("2026-06-18T12:00:00Z"),
    });
    expect(r.state).toBe("expired");
    expect(r.reason).toMatch(/reconnect/i);
  });

  it("ignores a STALE failure that predates the last (re)connect — a fresh reconnect is healthy", () => {
    const r = deriveClaudeConnectionHealth({
      connected: true,
      connectedAt: new Date("2026-06-18T12:00:00Z"),
      lastAuthFailureAt: new Date("2026-06-18T09:00:00Z"),
    });
    expect(r.state).toBe("connected");
    expect(r.reason).toBeNull();
  });

  it("fail-closed: a failure with no connectedAt to compare is treated as current (expired)", () => {
    const r = deriveClaudeConnectionHealth({
      connected: true,
      connectedAt: null,
      lastAuthFailureAt: new Date("2026-06-18T09:00:00Z"),
    });
    expect(r.state).toBe("expired");
  });

  it("a same-instant failure counts as current (surfaces the problem rather than hiding it)", () => {
    const t = new Date("2026-06-18T10:00:00Z");
    const r = deriveClaudeConnectionHealth({ connected: true, connectedAt: t, lastAuthFailureAt: t });
    expect(r.state).toBe("expired");
  });
});
