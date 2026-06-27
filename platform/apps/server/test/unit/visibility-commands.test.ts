import { describe, expect, it } from "vitest";
import { parseVisibilityChannelCommand } from "../../src/messaging/visibility-commands.js";

describe("visibility channel command parser (#1267)", () => {
  it("parses explicit approval commands from messaging replies", () => {
    expect(parseVisibilityChannelCommand("YES ship homepage because copy is approved")).toEqual({
      kind: "approval_decision",
      decision: "approve",
      target: "ship homepage",
      reason: "copy is approved",
    });
    expect(parseVisibilityChannelCommand("approve draft 3")).toEqual({
      kind: "approval_decision",
      decision: "approve",
      target: "draft 3",
      reason: null,
    });
  });

  it("parses rejection and pause commands without executing them", () => {
    expect(parseVisibilityChannelCommand("reject outbound campaign reason: wrong segment")).toEqual({
      kind: "approval_decision",
      decision: "reject",
      target: "outbound campaign",
      reason: "wrong segment",
    });
    expect(parseVisibilityChannelCommand("pause outbound")).toEqual({
      kind: "pause",
      target: "outbound",
      reason: null,
    });
  });

  it("ignores ordinary room chat", () => {
    expect(parseVisibilityChannelCommand("tell Scout to compare competitors")).toBeNull();
    expect(parseVisibilityChannelCommand("")).toBeNull();
  });
});
