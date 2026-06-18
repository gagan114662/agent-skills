import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/loader.js";
import {
  resolveActionContractFlags,
  canApply,
  ACTION_CONTRACT_FLAGS_OFF,
} from "../../src/action-contract/contract.js";

/**
 * #337 — the action-contract flag flows through the layered config (#58) and resolves DEFAULT OFF,
 * owner-workspace-first. A deployment that sets nothing applies nothing, and an irreversible apply needs a
 * SECOND switch.
 */
describe("action contract config flag (#337)", () => {
  it("defaults to an empty (all-off) block when nothing is configured", () => {
    const cfg = loadConfig("ws1", { env: {}, readFile: () => undefined });
    expect(cfg.actionContract).toEqual({});
    expect(resolveActionContractFlags(cfg.actionContract, "ws1")).toEqual(ACTION_CONTRACT_FLAGS_OFF);
  });

  it("enables ONLY the named owner workspace, and irreversible apply stays off without its switch", () => {
    const toml = [
      "[actionContract]",
      "enabled = true",
      'ownerWorkspaceId = "owner-ws"',
      "",
    ].join("\n");
    const cfg = loadConfig("owner-ws", {
      env: {},
      readFile: (p) => (p.endsWith("settings.toml") ? toml : undefined),
      repoPath: "/x/.reload/settings.toml",
    });
    const flags = resolveActionContractFlags(cfg.actionContract, "owner-ws");
    expect(flags).toEqual({ enabled: true, applyIrreversible: false });
    // reversible/cheap may apply; irreversible may NOT (its switch is off)
    expect(canApply(flags, "reversible")).toBe(true);
    expect(canApply(flags, "irreversible")).toBe(false);
    // a different workspace, same config → still off (owner-workspace-first)
    expect(resolveActionContractFlags(cfg.actionContract, "someone-else")).toEqual(ACTION_CONTRACT_FLAGS_OFF);
  });

  it("turns irreversible apply on only when both switches are set for the owner workspace", () => {
    const toml = [
      "[actionContract]",
      "enabled = true",
      "applyIrreversible = true",
      'ownerWorkspaceId = "owner-ws"',
      "",
    ].join("\n");
    const cfg = loadConfig("owner-ws", {
      env: {},
      readFile: (p) => (p.endsWith("settings.toml") ? toml : undefined),
      repoPath: "/x/.reload/settings.toml",
    });
    const flags = resolveActionContractFlags(cfg.actionContract, "owner-ws");
    expect(flags).toEqual({ enabled: true, applyIrreversible: true });
    expect(canApply(flags, "irreversible")).toBe(true);
  });

  it("enabling without naming the owner workspace enables nobody (safest default)", () => {
    const toml = ["[actionContract]", "enabled = true", ""].join("\n");
    const cfg = loadConfig("any-ws", {
      env: {},
      readFile: (p) => (p.endsWith("settings.toml") ? toml : undefined),
      repoPath: "/x/.reload/settings.toml",
    });
    expect(resolveActionContractFlags(cfg.actionContract, "any-ws")).toEqual(ACTION_CONTRACT_FLAGS_OFF);
  });
});
