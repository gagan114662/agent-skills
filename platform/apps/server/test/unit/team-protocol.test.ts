import { describe, it, expect } from "vitest";
import type { TeamEvent } from "@reload/shared";
import {
  encodeTeamEvent,
  tryParseTeamEvent,
  TEAM_EVENT_MARKER,
} from "../../src/team/protocol.js";

const sample = (over: Partial<TeamEvent> = {}): TeamEvent => ({
  teamRunId: "run_1",
  subtaskId: "sub_1",
  agentMemberId: "mem_agent",
  kind: "milestone",
  summary: "wrote the parser",
  branch: "feat/parser",
  createdAt: "2026-06-08T00:00:00.000Z",
  ...over,
});

describe("team channel protocol (encode / tryParse)", () => {
  it("round-trips every event kind through encode → parse", () => {
    for (const kind of ["started", "milestone", "blocked", "needs_handoff", "done"] as const) {
      const event = sample({ kind });
      const decoded = tryParseTeamEvent(encodeTeamEvent(event));
      expect(decoded).toEqual(event);
    }
  });

  it("preserves a null branch (before one is assigned)", () => {
    const event = sample({ branch: null });
    expect(tryParseTeamEvent(encodeTeamEvent(event))).toEqual(event);
  });

  it("tags the body with the marker prefix", () => {
    expect(encodeTeamEvent(sample())).toMatch(new RegExp(`^${TEAM_EVENT_MARKER} `));
  });

  it("returns null for ordinary chatter (not a team event)", () => {
    expect(tryParseTeamEvent("hello team, how's it going?")).toBeNull();
    expect(tryParseTeamEvent("")).toBeNull();
  });

  it("returns null for a marker with malformed JSON", () => {
    expect(tryParseTeamEvent(`${TEAM_EVENT_MARKER} {not json`)).toBeNull();
  });

  it("rejects an unknown kind", () => {
    const body = `${TEAM_EVENT_MARKER} ${JSON.stringify({ ...sample(), kind: "exploded" })}`;
    expect(tryParseTeamEvent(body)).toBeNull();
  });

  it("rejects an event missing required fields", () => {
    const body = `${TEAM_EVENT_MARKER} ${JSON.stringify({ teamRunId: "r", kind: "done" })}`;
    expect(tryParseTeamEvent(body)).toBeNull();
  });
});
