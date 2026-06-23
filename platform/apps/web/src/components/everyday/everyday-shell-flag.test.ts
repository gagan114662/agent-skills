/**
 * Pure everyday-shell-gate tests (#784). #784 go-live makes the shell the production default: with no owner
 * workspace pinned it shows for ANY signed-in workspace (full rollout); pinning an owner narrows it back to
 * owner-only. The only fail-closed branches are an explicitly-off flag and a missing current workspace.
 */
import { describe, expect, it } from "vitest";
import { shouldShowEverydayShell, type EverydayShellGateInput } from "./everyday-shell-flag.js";

const owner = "ws_owner_123";
const on: EverydayShellGateInput = { flagOn: true, ownerWorkspaceId: owner, workspaceId: owner };

describe("shouldShowEverydayShell (#784)", () => {
  it("shows for the named owner workspace when the flag is on", () => {
    expect(shouldShowEverydayShell(on)).toBe(true);
  });

  it("an explicitly-off flag shows for nobody, even the owner", () => {
    expect(shouldShowEverydayShell({ ...on, flagOn: false })).toBe(false);
  });

  it("full rollout: with no owner pinned, shows for any signed-in workspace", () => {
    expect(
      shouldShowEverydayShell({ flagOn: true, ownerWorkspaceId: undefined, workspaceId: "ws_anyone" }),
    ).toBe(true);
    expect(
      shouldShowEverydayShell({ flagOn: true, ownerWorkspaceId: "", workspaceId: "ws_anyone" }),
    ).toBe(true);
    expect(
      shouldShowEverydayShell({ flagOn: true, ownerWorkspaceId: "   ", workspaceId: "ws_anyone" }),
    ).toBe(true);
  });

  it("hides from a non-owner workspace when an owner IS pinned (owner-only narrowing)", () => {
    expect(shouldShowEverydayShell({ ...on, workspaceId: "ws_someone_else" })).toBe(false);
  });

  it("hides when there is no current workspace (the shell is a logged-in surface), pinned or not", () => {
    expect(
      shouldShowEverydayShell({ flagOn: true, ownerWorkspaceId: owner, workspaceId: null }),
    ).toBe(false);
    expect(
      shouldShowEverydayShell({ flagOn: true, ownerWorkspaceId: undefined, workspaceId: undefined }),
    ).toBe(false);
    expect(
      shouldShowEverydayShell({ flagOn: true, ownerWorkspaceId: undefined, workspaceId: "" }),
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
