import { describe, expect, it } from "vitest";
import { shouldShowShortFormBlitz, type ShortFormBlitzGateInput } from "./short-form-blitz-flag.js";

const owner = "ws_owner_744";
const on: ShortFormBlitzGateInput = { flagOn: true, ownerWorkspaceId: owner, workspaceId: owner };

describe("shouldShowShortFormBlitz (#744)", () => {
  it("shows only for the named owner workspace when the flag is on", () => {
    expect(shouldShowShortFormBlitz(on)).toBe(true);
  });

  it("is OFF by default, even for the owner", () => {
    expect(shouldShowShortFormBlitz({ ...on, flagOn: false })).toBe(false);
  });

  it("hides from non-owner workspaces and missing workspace ids", () => {
    expect(shouldShowShortFormBlitz({ ...on, workspaceId: "ws_other" })).toBe(false);
    expect(shouldShowShortFormBlitz({ ...on, workspaceId: "" })).toBe(false);
    expect(shouldShowShortFormBlitz({ ...on, workspaceId: undefined })).toBe(false);
  });

  it("naming nobody provisions the surface for nobody", () => {
    expect(shouldShowShortFormBlitz({ flagOn: true, ownerWorkspaceId: "", workspaceId: owner })).toBe(false);
    expect(shouldShowShortFormBlitz({ flagOn: true, ownerWorkspaceId: "   ", workspaceId: owner })).toBe(false);
    expect(shouldShowShortFormBlitz({ flagOn: true, ownerWorkspaceId: undefined, workspaceId: owner })).toBe(false);
  });

  it("trims owner and workspace ids before matching", () => {
    expect(shouldShowShortFormBlitz({ flagOn: true, ownerWorkspaceId: ` ${owner} `, workspaceId: `${owner} ` })).toBe(
      true,
    );
  });
});
