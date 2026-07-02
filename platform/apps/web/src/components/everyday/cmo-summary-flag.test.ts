import { describe, expect, it } from "vitest";

import { shouldShowCmoSummary } from "./cmo-summary-flag";

/** #1456 — the CMO strip is a new surface: DEFAULT-OFF, owner-workspace-first, fail-closed. */
describe("shouldShowCmoSummary", () => {
  it("hides when the flag is off (default-off)", () => {
    expect(shouldShowCmoSummary({ flagOn: false, workspaceId: "ws-1" })).toBe(false);
  });

  it("hides when there is no current workspace", () => {
    expect(shouldShowCmoSummary({ flagOn: true, workspaceId: null })).toBe(false);
    expect(shouldShowCmoSummary({ flagOn: true, workspaceId: "   " })).toBe(false);
  });

  it("shows for any signed-in workspace when no owner id is configured", () => {
    expect(shouldShowCmoSummary({ flagOn: true, workspaceId: "ws-1" })).toBe(true);
  });

  it("shows only for the owner workspace when an owner id is configured", () => {
    expect(shouldShowCmoSummary({ flagOn: true, ownerWorkspaceId: "ws-owner", workspaceId: "ws-owner" })).toBe(true);
    expect(shouldShowCmoSummary({ flagOn: true, ownerWorkspaceId: "ws-owner", workspaceId: "ws-other" })).toBe(false);
  });

  it("ignores blank owner id (treated as unconfigured)", () => {
    expect(shouldShowCmoSummary({ flagOn: true, ownerWorkspaceId: "  ", workspaceId: "ws-1" })).toBe(true);
  });
});
