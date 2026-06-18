import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/loader.js";
import { resolveSocialFlags, SOCIAL_FLAGS_OFF } from "../../src/social/decide.js";

/**
 * #269 — the social-posting flag flows through the layered config (#58) and resolves DEFAULT OFF,
 * owner-workspace-first. A deployment that sets nothing posts nothing.
 */
describe("social config flag (#269)", () => {
  it("defaults to an empty (off) block when nothing is configured", () => {
    const cfg = loadConfig("ws1", { env: {}, readFile: () => undefined });
    expect(cfg.social).toEqual({});
    expect(resolveSocialFlags(cfg.social, "ws1")).toEqual(SOCIAL_FLAGS_OFF);
  });

  it("the RELOAD_SOCIAL_* env opts the owner workspace in (and no one else)", () => {
    const env = {
      RELOAD_SOCIAL_ENABLED: "true",
      RELOAD_SOCIAL_OWNER_WORKSPACE_ID: "owner-ws",
    };
    const owner = loadConfig("owner-ws", { env, readFile: () => undefined });
    expect(resolveSocialFlags(owner.social, "owner-ws").enabled).toBe(true);
    const other = loadConfig("other-ws", { env, readFile: () => undefined });
    expect(resolveSocialFlags(other.social, "other-ws").enabled).toBe(false);
  });

  it("reuses the #258 marketing owner marker when no dedicated owner id is set", () => {
    const env = {
      RELOAD_SOCIAL_ENABLED: "true",
      RELOAD_MARKETING_OWNER_WORKSPACE_ID: "mkt-owner",
    };
    const cfg = loadConfig("mkt-owner", { env, readFile: () => undefined });
    expect(resolveSocialFlags(cfg.social, "mkt-owner").enabled).toBe(true);
  });
});
