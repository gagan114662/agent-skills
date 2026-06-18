/**
 * Pure coordination-gate tests (#352). Lock the default-OFF, owner-workspace-first contract: the surface
 * shows ONLY when the flag is on AND a non-empty owner workspace is named AND the current workspace IS that
 * owner. Every other branch is fail-closed — there is no path where an off flag, a missing workspace, or an
 * unnamed owner reveals the surface (matching the agentRegistry/agentCollaboration/durableWorkflow backend
 * default: "turning it on without naming ownerWorkspaceId provisions it for nobody").
 */
import { describe, expect, it } from "vitest";
import { shouldShowCoordination, type CoordinationGateInput } from "./coordination-flag.js";

const owner = "ws_owner_123";
const on: CoordinationGateInput = { flagOn: true, ownerWorkspaceId: owner, workspaceId: owner };

describe("shouldShowCoordination (#352)", () => {
  it("shows for the named owner workspace when the flag is on", () => {
    expect(shouldShowCoordination(on)).toBe(true);
  });

  it("is OFF by default — flag off shows for nobody, even the owner", () => {
    expect(shouldShowCoordination({ ...on, flagOn: false })).toBe(false);
  });

  it("hides from a non-owner workspace even when the flag is on (owner-first)", () => {
    expect(shouldShowCoordination({ ...on, workspaceId: "ws_someone_else" })).toBe(false);
  });

  it("naming nobody (no owner id) shows it to nobody, flag on or not", () => {
    expect(shouldShowCoordination({ flagOn: true, ownerWorkspaceId: undefined, workspaceId: owner })).toBe(false);
    expect(shouldShowCoordination({ flagOn: true, ownerWorkspaceId: "", workspaceId: owner })).toBe(false);
    expect(shouldShowCoordination({ flagOn: true, ownerWorkspaceId: "   ", workspaceId: owner })).toBe(false);
  });

  it("hides when there is no current workspace, even for a named owner", () => {
    expect(shouldShowCoordination({ flagOn: true, ownerWorkspaceId: owner, workspaceId: null })).toBe(false);
    expect(shouldShowCoordination({ flagOn: true, ownerWorkspaceId: owner, workspaceId: undefined })).toBe(false);
    expect(shouldShowCoordination({ flagOn: true, ownerWorkspaceId: owner, workspaceId: "" })).toBe(false);
  });

  it("matches owner vs workspace after trimming surrounding whitespace", () => {
    expect(shouldShowCoordination({ flagOn: true, ownerWorkspaceId: ` ${owner} `, workspaceId: `${owner} ` })).toBe(
      true,
    );
    expect(shouldShowCoordination({ flagOn: true, ownerWorkspaceId: owner, workspaceId: `${owner}x` })).toBe(false);
  });
});
