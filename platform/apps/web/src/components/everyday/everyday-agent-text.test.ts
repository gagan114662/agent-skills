import { describe, expect, it } from "vitest";
import { EVERYDAY } from "../../brand.js";
import {
  customerVisibleAgentText,
  parseTeamEvent,
  teamEventFriendlyLine,
  TEAM_EVENT_MARKER,
} from "./everyday-agent-text.js";

/**
 * The everyday room is a customer surface: only human-readable brand-voice lines may ever render. These
 * cover the two internal-noise classes that must never leak — `::team-event::` JSON blobs and runtime/log
 * output (codex_core::shell_snapshot ERROR ...).
 */

function teamEvent(overrides: Record<string, unknown> = {}): string {
  return (
    TEAM_EVENT_MARKER +
    " " +
    JSON.stringify({
      teamRunId: "tr1",
      subtaskId: "s1",
      agentMemberId: "a1",
      kind: "started",
      summary: "started: Scout site read",
      branch: "scout/site-read",
      createdAt: "2026-07-01T00:00:00.000Z",
      ...overrides,
    })
  );
}

describe("everyday-agent-text", () => {
  it("shows a team-event's human summary, never the raw JSON", () => {
    const out = customerVisibleAgentText(teamEvent());
    expect(out).toBe("started: Scout site read");
    expect(out).not.toContain("teamRunId");
    expect(out).not.toContain(TEAM_EVENT_MARKER);
  });

  it("derives a friendly milestone line for a real team-event with no summary", () => {
    const event = parseTeamEvent(teamEvent({ kind: "milestone", summary: "" }));
    expect(event).not.toBeNull();
    const line = teamEventFriendlyLine(event!);
    expect(line).toBe("your team just hit a milestone.");
    expect(line).not.toContain("teamRunId");
  });

  it("never leaks a malformed / truncated team-event blob", () => {
    const truncated = TEAM_EVENT_MARKER + ' {"teamRunId":"tr1","agentMemberId":"a1","branch":"scout/x"';
    const out = customerVisibleAgentText(truncated);
    expect(out).toBe(EVERYDAY.thread.internalToolActivity);
    expect(out).not.toContain("teamRunId");
    expect(out).not.toContain("branch");
  });

  it("hides raw codex runtime log lines", () => {
    for (const log of [
      "2026-07-01T12:00:00.000Z ERROR codex_core::shell_snapshot: snapshot failed",
      "ERROR codex_core::shell_snapshot failed to capture output",
      "codex_core::shell_snapshot: WARN retrying",
      "thread 'tokio-runtime-worker' panicked at 'boom'",
    ]) {
      expect(customerVisibleAgentText(log)).toBe(EVERYDAY.thread.internalToolActivity);
    }
  });

  it("hides raw shell/tool invocations", () => {
    expect(customerVisibleAgentText(`/bin/sh -lc "sed -n '1,220p' receipt.md"`)).toBe(
      EVERYDAY.thread.internalToolActivity,
    );
    expect(customerVisibleAgentText("🔧 node -e \"fetch('https://ipop.ai/')\"")).toBe(
      EVERYDAY.thread.internalToolActivity,
    );
  });

  it("passes genuine human agent messages through untouched", () => {
    const human = "Found a broken CTA on your pricing page — want me to draft a fix?";
    expect(customerVisibleAgentText(human)).toBe(human);
  });

  it("does not treat arbitrary JSON as a team-event", () => {
    expect(parseTeamEvent(TEAM_EVENT_MARKER + ' {"foo":"bar"}')).toBeNull();
  });
});
