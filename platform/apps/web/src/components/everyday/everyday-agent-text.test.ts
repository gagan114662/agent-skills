import { describe, expect, it } from "vitest";
import { EVERYDAY } from "../../brand.js";
import {
  canonicalRoomAgentName,
  customerVisibleAgentText,
  isSessionOutcomeSuccessLine,
  parseTeamEvent,
  rewriteSessionFailure,
  roomAgentRole,
  scrubInternalJargon,
  teamEventAgentName,
  teamEventFriendlyLine,
  TEAM_EVENT_MARKER,
} from "./everyday-agent-text.js";

/**
 * The everyday room is a customer surface (#1584): the transcript must read like a real team chat, never a
 * pipeline telemetry feed. These cover the six rules — named agents, first-person outcomes, visible
 * handoffs, subtle lifecycle lines, honest errors — plus the two internal-noise classes (raw team-event
 * JSON and runtime/log output) that must never leak.
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
      summary: "started: Scout insight mining",
      branch: "ipop-scout-site-read",
      createdAt: "2026-07-01T00:00:00.000Z",
      ...overrides,
    })
  );
}

describe("everyday-agent-text — room chat voice", () => {
  it("rewrites a coordinator 'started' summary into a named, first-person line — never telemetry", () => {
    const out = customerVisibleAgentText(teamEvent());
    expect(out).toContain("I'm digging into");
    expect(out).not.toContain("started:");
    expect(out).not.toContain("insight mining");
    expect(out).not.toContain("teamRunId");
    expect(out).not.toContain(TEAM_EVENT_MARKER);
  });

  it("makes a finished lane conversationally hand off to the next teammate", () => {
    const scoutDone = teamEventFriendlyLine(parseTeamEvent(teamEvent({ kind: "done", summary: "done: Scout insight mining" }))!);
    expect(scoutDone).toContain("Quill");
    const quillDone = teamEventFriendlyLine(parseTeamEvent(teamEvent({ kind: "done", summary: "done: Quill creative platform" }))!);
    expect(quillDone).toContain("Lens");
    const lensDone = teamEventFriendlyLine(parseTeamEvent(teamEvent({ kind: "done", summary: "done: Lens taste and proof" }))!);
    expect(lensDone).toContain("Echo");
  });

  it("surfaces the Codex operator lane under the customer-facing name Operator", () => {
    expect(canonicalRoomAgentName("Codex operator")).toBe("Operator");
    const started = teamEventFriendlyLine(parseTeamEvent(teamEvent({ summary: "started: Codex operator lane" }))!);
    expect(started).toContain("approved decisions");
    expect(started.toLowerCase()).not.toContain("codex");
  });

  it("resolves the named agent from a lifecycle summary even when no directory entry exists", () => {
    expect(teamEventAgentName(parseTeamEvent(teamEvent({ summary: "queued: Lens taste and proof" }))!)).toBe("Lens");
    expect(teamEventAgentName(parseTeamEvent(teamEvent({ summary: "blocked: missing required artifact: draft set" }))!)).toBeNull();
  });

  it("turns a 'queued' lifecycle summary into a subtle update, not 'queued: <lane>'", () => {
    const out = customerVisibleAgentText(teamEvent({ kind: "queued", summary: "queued: Lens taste and proof" }));
    expect(out).not.toContain("queued:");
    expect(out).not.toContain("taste and proof");
    expect(out).toBe("Getting set up — I'll post here the moment I've got something worth sharing.");
  });

  it("states an upstream block honestly instead of 'blocked: missing required artifact'", () => {
    const out = customerVisibleAgentText(teamEvent({ kind: "blocked", summary: "blocked: missing required artifact: draft_set" }));
    expect(out).not.toMatch(/artifact/i);
    expect(out).not.toContain("blocked:");
    expect(out).toBe("I'm waiting on the earlier step to finish before I can pick this up.");
  });

  it("reports a retry as an honest snag, never the raw error tail", () => {
    const out = customerVisibleAgentText(
      teamEvent({ kind: "milestone", summary: "retrying: Scout insight mining after timed out after 900000ms" }),
    );
    expect(out).toContain("snag");
    expect(out).not.toMatch(/timed out|900000|retrying:/);
  });

  it("exposes role labels for the named team", () => {
    expect(roomAgentRole("Scout")).toBe("Research");
    expect(roomAgentRole("Operator")).toBe("Operator");
    expect(roomAgentRole("Codex operator")).toBe("Operator");
    expect(roomAgentRole("member-019eb7")).toBeNull();
  });
});

describe("everyday-agent-text — session terminal + noise", () => {
  it("treats the runtime's exit-code success line as plumbing, never showing '(exit 0)'", () => {
    expect(isSessionOutcomeSuccessLine("✅ session completed (exit 0)")).toBe(true);
    const out = customerVisibleAgentText("✅ session completed (exit 0)");
    expect(out).not.toContain("exit");
    expect(out).toBe(EVERYDAY.thread.internalToolActivity);
  });

  it("rewrites the runtime failure line into honest plain language, dropping the class tag and exit footer", () => {
    const failure =
      "❌ I hit a snag reading the site and had to stop _(error)_\n" +
      "The details are in the thread above — nudge me to retry.\n\n" +
      "`session failed · exit n/a`";
    const out = customerVisibleAgentText(failure);
    expect(out).toContain("I hit a snag reading the site");
    expect(out).toContain("nudge me to retry");
    expect(out).not.toContain("_(error)_");
    expect(out).not.toMatch(/exit|session failed|❌/);
    expect(rewriteSessionFailure("just a normal message")).toBeNull();
  });

  it("scrubs exit codes, class tags, UUIDs, and branch tokens from any leaking text", () => {
    expect(scrubInternalJargon("done (exit 0) on ipop-scout-site-read")).toBe("done on");
    expect(scrubInternalJargon("failed _(spawn)_ 019eb7aa-1111-2222-3333-444455556666")).toBe("failed");
  });

  it("still shows a genuine agent one-liner untouched (not lifecycle-prefixed)", () => {
    const out = customerVisibleAgentText(teamEvent({ summary: "reading your homepage" }));
    expect(out).toBe("reading your homepage");
  });

  it("derives a soft fallback line for a real team-event with no summary", () => {
    const line = teamEventFriendlyLine(parseTeamEvent(teamEvent({ kind: "milestone", summary: "" }))!);
    expect(line).toBe("Made some progress — more in a moment.");
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
