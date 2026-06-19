/**
 * Pure venture-intake-gate tests (#387). Lock the default-OFF, owner-workspace-first contract: the brief
 * panel shows ONLY when the flag is on AND a non-empty owner workspace is named AND the current workspace
 * IS that owner. Every other branch is fail-closed — mirrors the backend `ventureIntake` flag.
 */
import { describe, expect, it } from "vitest";
import { shouldShowVentureIntake, type VentureIntakeGateInput } from "./venture-intake-flag.js";

const owner = "ws_owner_387";
const on: VentureIntakeGateInput = { flagOn: true, ownerWorkspaceId: owner, workspaceId: owner };

describe("shouldShowVentureIntake (#387)", () => {
  it("shows for the named owner workspace when the flag is on", () => {
    expect(shouldShowVentureIntake(on)).toBe(true);
  });

  it("is OFF by default — flag off shows for nobody, even the owner", () => {
    expect(shouldShowVentureIntake({ ...on, flagOn: false })).toBe(false);
  });

  it("hides from a non-owner workspace even when the flag is on (owner-first)", () => {
    expect(shouldShowVentureIntake({ ...on, workspaceId: "ws_someone_else" })).toBe(false);
  });

  it("naming nobody (no owner id) shows it to nobody, flag on or not", () => {
    expect(shouldShowVentureIntake({ flagOn: true, ownerWorkspaceId: undefined, workspaceId: owner })).toBe(false);
    expect(shouldShowVentureIntake({ flagOn: true, ownerWorkspaceId: "", workspaceId: owner })).toBe(false);
    expect(shouldShowVentureIntake({ flagOn: true, ownerWorkspaceId: "   ", workspaceId: owner })).toBe(false);
  });

  it("hides when there is no current workspace, even for a named owner", () => {
    expect(shouldShowVentureIntake({ flagOn: true, ownerWorkspaceId: owner, workspaceId: null })).toBe(false);
    expect(shouldShowVentureIntake({ flagOn: true, ownerWorkspaceId: owner, workspaceId: undefined })).toBe(false);
    expect(shouldShowVentureIntake({ flagOn: true, ownerWorkspaceId: owner, workspaceId: "" })).toBe(false);
  });

  it("matches owner vs workspace after trimming surrounding whitespace", () => {
    expect(
      shouldShowVentureIntake({ flagOn: true, ownerWorkspaceId: ` ${owner} `, workspaceId: `${owner} ` }),
    ).toBe(true);
    expect(shouldShowVentureIntake({ flagOn: true, ownerWorkspaceId: owner, workspaceId: `${owner}x` })).toBe(
      false,
    );
  });
});
