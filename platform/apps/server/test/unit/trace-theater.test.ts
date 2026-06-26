import { describe, it, expect } from "vitest";
import {
  SUMMARY_MAX,
  browserActionForEvent,
  phaseForType,
  selectNewEvents,
  sseComment,
  sseFrame,
  summarizeTracePayload,
  toTheaterEvent,
} from "../../src/trace/theater.js";
import type { TraceEvent } from "../../src/trace/types.js";

/** Unit test for the pure live-theater projection (issue #624) — no DB, no socket. */

function ev(partial: Partial<TraceEvent> & Pick<TraceEvent, "type" | "seq">): TraceEvent {
  return {
    id: `e${partial.seq}`,
    runId: "run-1",
    seq: partial.seq,
    type: partial.type,
    turn: partial.turn ?? 0,
    label: partial.label ?? null,
    payload: partial.payload ?? {},
    inputTokens: null,
    outputTokens: null,
    costMicros: null,
    occurredAt: partial.occurredAt ?? new Date("2026-06-22T00:00:00.000Z"),
  };
}

describe("phaseForType", () => {
  it("maps every trace event type to its watchable phase", () => {
    expect(phaseForType("model_request")).toBe("context");
    expect(phaseForType("model_response")).toBe("reasoning");
    expect(phaseForType("tool_call")).toBe("action");
    expect(phaseForType("tool_result")).toBe("artifact");
    expect(phaseForType("approval_decision")).toBe("approval");
  });
});

describe("summarizeTracePayload", () => {
  it("reads the reasoning out of a model response", () => {
    expect(summarizeTracePayload("model_response", "opus", { reasoning: "I will draft the email" })).toBe(
      "I will draft the email",
    );
  });

  it("summarizes a tool call from its args/command", () => {
    expect(summarizeTracePayload("tool_call", "shell", { command: "git status" })).toBe("git status");
  });

  it("summarizes a tool result from its output", () => {
    expect(summarizeTracePayload("tool_result", "shell", { output: "branch is clean" })).toBe(
      "branch is clean",
    );
  });

  it("flattens whitespace and clamps long summaries to the cap", () => {
    const long = "x".repeat(SUMMARY_MAX + 50);
    const out = summarizeTracePayload("model_response", null, { text: long });
    expect(out.length).toBe(SUMMARY_MAX);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back to compact JSON for an unconventional payload", () => {
    expect(summarizeTracePayload("tool_result", "x", { weird: 1 })).toBe('{"weird":1}');
  });

  it("never returns empty: uses the label when payload is empty", () => {
    expect(summarizeTracePayload("tool_call", "deploy", {})).toBe("deploy");
  });

  it("joins array message content (e.g. content blocks)", () => {
    const out = summarizeTracePayload("model_response", null, {
      content: [{ text: "step one" }, { text: "step two" }],
    });
    expect(out).toBe("step one step two");
  });
});

describe("toTheaterEvent", () => {
  it("projects a persisted event into phase + summary + ISO timestamp", () => {
    const out = toTheaterEvent(
      ev({ type: "tool_call", seq: 3, turn: 1, label: "browser", payload: { input: "open ipop.ai" } }),
    );
    expect(out).toMatchObject({
      runId: "run-1",
      seq: 3,
      turn: 1,
      type: "tool_call",
      phase: "action",
      label: "browser",
      summary: "open ipop.ai",
      occurredAt: "2026-06-22T00:00:00.000Z",
    });
  });

  it("projects browser receipts as watchable screen metadata", () => {
    const out = toTheaterEvent(
      ev({
        type: "tool_result",
        seq: 4,
        label: "navigate",
        payload: {
          ok: true,
          tool: "navigate",
          decision: "allow",
          url: "https://ipop.ai",
          status: 200,
          screenshotPath: "browser://shot-1",
        },
      }),
    );
    expect(out.browser).toEqual({
      tool: "navigate",
      url: "https://ipop.ai",
      decision: "allow",
      approvalRequestId: null,
      screenshotPath: "browser://shot-1",
      status: 200,
      summary: "navigate on https://ipop.ai",
    });
  });
});

describe("browserActionForEvent", () => {
  it("detects a side-effectful browser action waiting on approval", () => {
    expect(
      browserActionForEvent("tool_result", "click", {
        result: {
          ok: false,
          tool: "click",
          decision: "needs_approval",
          url: "https://example.com/pricing",
          approvalRequestId: "appr-1",
          screenshotPath: null,
        },
      }),
    ).toMatchObject({
      tool: "click",
      decision: "needs_approval",
      approvalRequestId: "appr-1",
      summary: "click is waiting for approval",
    });
  });

  it("ignores ordinary non-browser tools", () => {
    expect(browserActionForEvent("tool_result", "shell", { output: "ok" })).toBeNull();
  });
});

describe("selectNewEvents", () => {
  it("returns only events past the cursor, in seq order, with the advanced cursor", () => {
    const events = [
      ev({ type: "model_response", seq: 1 }),
      ev({ type: "tool_call", seq: 2 }),
      ev({ type: "tool_result", seq: 3 }),
    ];
    const out = selectNewEvents(events, 1);
    expect(out.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(out.cursor).toBe(3);
  });

  it("holds the cursor when nothing is new", () => {
    const events = [ev({ type: "model_response", seq: 1 })];
    expect(selectNewEvents(events, 5).cursor).toBe(5);
    expect(selectNewEvents(events, 5).events).toEqual([]);
  });
});

describe("sse framing", () => {
  it("formats a named event frame with single-line JSON data", () => {
    expect(sseFrame("event", { a: 1 })).toBe('event: event\ndata: {"a":1}\n\n');
  });

  it("formats a heartbeat comment", () => {
    expect(sseComment()).toBe(": ping\n\n");
  });
});
