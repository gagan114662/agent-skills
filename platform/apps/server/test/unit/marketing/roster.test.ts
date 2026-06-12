import { describe, it, expect } from "vitest";
import { buildMarketingRoster } from "../../../src/marketing/roster.js";

/**
 * #123 team panel — humans + department agents with roles, presence reflecting live #105 session state.
 * Pure: the route gathers members/personas/live sessions and hands them here.
 */
describe("#123 marketing roster", () => {
  const members = [
    { id: "h1", kind: "human" as const, displayName: "Gagan" },
    { id: "a-scout", kind: "agent" as const, displayName: "scout" },
    { id: "a-echo", kind: "agent" as const, displayName: "echo" },
    { id: "a-custom", kind: "agent" as const, displayName: "code-reviewer" },
  ];
  const personas = [
    { agentMemberId: "a-scout", name: "scout" },
    { agentMemberId: "a-echo", name: "echo" },
    { agentMemberId: "a-custom", name: "code-reviewer" },
  ];

  it("lists humans and marketing agents with their department roles", () => {
    const roster = buildMarketingRoster({ members, personas, liveSessionMemberIds: [] });
    expect(roster.humans).toEqual([{ memberId: "h1", displayName: "Gagan" }]);
    const scout = roster.agents.find((a) => a.handle === "scout");
    expect(scout).toMatchObject({ memberId: "a-scout", department: "seo", title: "SEO", present: false });
    // A non-marketing persona (code-reviewer) is not part of the department panel.
    expect(roster.agents.find((a) => a.handle === "code-reviewer")).toBeUndefined();
    expect(roster.agents).toHaveLength(2);
  });

  it("marks an agent present when it has a live session (#105)", () => {
    const roster = buildMarketingRoster({ members, personas, liveSessionMemberIds: ["a-echo"] });
    expect(roster.agents.find((a) => a.handle === "echo")?.present).toBe(true);
    expect(roster.agents.find((a) => a.handle === "scout")?.present).toBe(false);
  });

  it("shows ALL fleet agents present when the fleet is enabled, even with no live session (#166)", () => {
    // QA bug 13: agents always showed grey/offline. When the fleet is enabled they're available to be
    // @mentioned, so the roster must report them present even when nothing is running right now.
    const roster = buildMarketingRoster({
      members,
      personas,
      liveSessionMemberIds: [],
      fleetEnabled: true,
    });
    expect(roster.agents.every((a) => a.present)).toBe(true);
  });

  it("defaults fleetEnabled to false (no behavior change when omitted)", () => {
    const roster = buildMarketingRoster({ members, personas, liveSessionMemberIds: [] });
    expect(roster.agents.every((a) => !a.present)).toBe(true);
  });
});
