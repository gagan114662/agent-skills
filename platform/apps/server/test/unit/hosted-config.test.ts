import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/loader.js";
import { resolveHostedSitesFlags, HOSTED_FLAGS_OFF } from "../../src/hosted/decide.js";

/**
 * #266 — the hosted-publishing flag flows through the layered config (#58) and resolves DEFAULT OFF,
 * owner-workspace-first. A deployment that sets nothing hosts nothing.
 */
describe("hostedSites config flag (#266)", () => {
  it("defaults to an empty (off) block when nothing is configured", () => {
    const cfg = loadConfig("ws1", { env: {}, readFile: () => undefined });
    expect(cfg.hostedSites).toEqual({});
    expect(resolveHostedSitesFlags(cfg.hostedSites, "ws1")).toEqual(HOSTED_FLAGS_OFF);
  });

  it("the RELOAD_HOSTEDSITES_* env opts the owner workspace in (and no one else)", () => {
    const env = {
      RELOAD_HOSTEDSITES_ENABLED: "true",
      RELOAD_HOSTEDSITES_OWNER_WORKSPACE_ID: "owner-ws",
    };
    const owner = loadConfig("owner-ws", { env, readFile: () => undefined });
    expect(resolveHostedSitesFlags(owner.hostedSites, "owner-ws").enabled).toBe(true);
    const other = loadConfig("other-ws", { env, readFile: () => undefined });
    expect(resolveHostedSitesFlags(other.hostedSites, "other-ws").enabled).toBe(false);
  });

  it("reuses the #258 marketing owner marker when no dedicated owner id is set", () => {
    const env = {
      RELOAD_HOSTEDSITES_ENABLED: "true",
      RELOAD_MARKETING_OWNER_WORKSPACE_ID: "mkt-owner",
    };
    const cfg = loadConfig("mkt-owner", { env, readFile: () => undefined });
    expect(resolveHostedSitesFlags(cfg.hostedSites, "mkt-owner").enabled).toBe(true);
  });

  it("carries a custom baseHost from env", () => {
    const env = {
      RELOAD_HOSTEDSITES_ENABLED: "true",
      RELOAD_HOSTEDSITES_OWNER_WORKSPACE_ID: "owner-ws",
      RELOAD_HOSTEDSITES_BASE_HOST: "pages.example.dev",
    };
    const cfg = loadConfig("owner-ws", { env, readFile: () => undefined });
    expect(cfg.hostedSites.baseHost).toBe("pages.example.dev");
  });
});
