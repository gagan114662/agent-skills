/**
 * Pure everyday-shell-gate tests (#784). Lock the default-OFF, owner-workspace-first contract: the redesign
 * shows ONLY when the flag is on AND a non-empty owner workspace is named AND the current workspace IS that
 * owner. Every other branch is fail-closed — there is no path where an off flag, a missing workspace, or an
 * unnamed owner reveals the shell.
 */
import { describe, expect, it } from "vitest";
import { shouldShowEverydayShell, type EverydayShellGateInput } from "./everyday-shell-flag.js";

const owner = "ws_owner_123";
const on: EverydayShellGateInput = { flagOn: true, ownerWorkspaceId: owner, workspaceId: owner };

describe("shouldShowEverydayShell (#784)", () => {
  it("shows for the named owner workspace when the flag is on", () => {
    expect(shouldShowEverydayShell(on)).toBe(true);
  });

  it("is OFF by default — flag off shows for nobody, even the owner", () => {
    expect(shouldShowEverydayShell({ ...on, flagOn: false })).toBe(false);
  });

  it("hides from a non-owner workspace even when the flag is on (owner-first)", () => {
    expect(shouldShowEverydayShell({ ...on, workspaceId: "ws_someone_else" })).toBe(false);
  });

  it("naming nobody (no owner id) shows it to nobody, flag on or not", () => {
    expect(
      shouldShowEverydayShell({ flagOn: true, ownerWorkspaceId: undefined, workspaceId: owner }),
    ).toBe(false);
    expect(
      shouldShowEverydayShell({ flagOn: true, ownerWorkspaceId: "", workspaceId: owner }),
    ).toBe(false);
    expect(
      shouldShowEverydayShell({ flagOn: true, ownerWorkspaceId: "   ", workspaceId: owner }),
    ).toBe(false);
  });

  it("hides when there is no current workspace, even for a named owner", () => {
    expect(
      shouldShowEverydayShell({ flagOn: true, ownerWorkspaceId: owner, workspaceId: null }),
    ).toBe(false);
    expect(
      shouldShowEverydayShell({ flagOn: true, ownerWorkspaceId: owner, workspaceId: undefined }),
    ).toBe(false);
    expect(
      shouldShowEverydayShell({ flagOn: true, ownerWorkspaceId: owner, workspaceId: "" }),
    ).toBe(false);
  });

  it("matches owner vs workspace after trimming surrounding whitespace", () => {
    expect(
      shouldShowEverydayShell({
        flagOn: true,
        ownerWorkspaceId: ` ${owner} `,
        workspaceId: `${owner} `,
      }),
    ).toBe(true);
    expect(
      shouldShowEverydayShell({ flagOn: true, ownerWorkspaceId: owner, workspaceId: `${owner}x` }),
    ).toBe(false);
  });
});
