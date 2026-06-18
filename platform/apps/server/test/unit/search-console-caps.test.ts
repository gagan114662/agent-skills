/**
 * Search Console caps tests (#265). Proves the feature is default-OFF and owner-workspace-first, resolved
 * off the existing `seo` config block.
 */
import { describe, expect, it } from "vitest";
import {
  SEARCH_CONSOLE_DEFAULTS,
  resolveSearchConsoleCaps,
  searchConsoleAutoSubmitEnabledForWorkspace,
} from "../../src/search-console/caps.js";

describe("resolveSearchConsoleCaps", () => {
  it("defaults to OFF + dryrun + no owner pin", () => {
    expect(resolveSearchConsoleCaps(undefined)).toEqual(SEARCH_CONSOLE_DEFAULTS);
    expect(resolveSearchConsoleCaps({})).toEqual(SEARCH_CONSOLE_DEFAULTS);
  });

  it("ignores an unknown provider kind (falls back to dryrun)", () => {
    expect(resolveSearchConsoleCaps({ searchConsoleProvider: "nope" }).provider).toBe("dryrun");
    expect(resolveSearchConsoleCaps({ searchConsoleProvider: "search_console" }).provider).toBe(
      "search_console",
    );
  });

  it("reads the flag + owner marker from the seo block", () => {
    const caps = resolveSearchConsoleCaps({ autoSubmitSitemap: true, ownerWorkspaceId: "ws-owner" });
    expect(caps.autoSubmitEnabled).toBe(true);
    expect(caps.ownerWorkspaceId).toBe("ws-owner");
  });
});

describe("searchConsoleAutoSubmitEnabledForWorkspace (owner-first)", () => {
  it("is false when the master flag is off, regardless of workspace", () => {
    const caps = resolveSearchConsoleCaps({ autoSubmitSitemap: false });
    expect(searchConsoleAutoSubmitEnabledForWorkspace(caps, "ws-owner")).toBe(false);
  });

  it("is true ONLY for the owner workspace when a pin is set", () => {
    const caps = resolveSearchConsoleCaps({ autoSubmitSitemap: true, ownerWorkspaceId: "ws-owner" });
    expect(searchConsoleAutoSubmitEnabledForWorkspace(caps, "ws-owner")).toBe(true);
    expect(searchConsoleAutoSubmitEnabledForWorkspace(caps, "ws-other")).toBe(false);
  });

  it("applies fleet-wide once enabled with no owner pin", () => {
    const caps = resolveSearchConsoleCaps({ autoSubmitSitemap: true });
    expect(searchConsoleAutoSubmitEnabledForWorkspace(caps, "anyone")).toBe(true);
  });
});
