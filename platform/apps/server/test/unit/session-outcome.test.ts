import { describe, it, expect } from "vitest";
import {
  classifyFailure,
  decideSessionDisposition,
  formatDeliverableMessage,
  looksLikeStartupFailure,
  MAX_REPLY_CHARS,
  renderSessionOutcome,
  type SessionOutcome,
} from "../../src/runtime/outcome.js";

/**
 * #166 — the "lying checkmark" regression. A failed session used to render `✅ session failed (exit
 * n/a)`: a green check on a failure. These cover the pure renderer that replaces that string: a green
 * check ONLY on a clean completion, otherwise a failure mark + brand-voice reason carrying the reason
 * class (spawn/auth/timeout/budget/canceled/error). The classifier is the testable seam.
 */

describe("classifyFailure (#166)", () => {
  it("classifies a process that never returned an exit code as spawn failure", () => {
    // The exact prod case: harness spawned `bash` but the image had none → ENOENT → no exit code.
    const o: SessionOutcome = { status: "failed", exitCode: null };
    expect(classifyFailure(o)).toBe("spawn");
  });

  it("classifies wall-clock and idle reaps as timeout", () => {
    expect(classifyFailure({ status: "timeout", exitCode: null })).toBe("timeout");
    expect(classifyFailure({ status: "idle_reaped", exitCode: null })).toBe("timeout");
  });

  it("classifies an explicit cancel as canceled, not spawn", () => {
    // A killed process also has a null exit code — canceled must win over the spawn heuristic.
    expect(classifyFailure({ status: "canceled", exitCode: null })).toBe("canceled");
  });

  it("classifies a non-zero exit with auth markers in the output as auth", () => {
    const o: SessionOutcome = {
      status: "failed",
      exitCode: 1,
      outputTail: "Error: Invalid API key · please run claude /login to authenticate",
    };
    expect(classifyFailure(o)).toBe("auth");
  });

  it("classifies a plain non-zero exit as a generic error", () => {
    expect(classifyFailure({ status: "failed", exitCode: 2, outputTail: "boom" })).toBe("error");
  });

  it("classifies a non-zero exit naming an unavailable model as a model misconfig (#242)", () => {
    // The exact prod case: ANTHROPIC_MODEL=claude-fable-5 (a non-existent model) → claude -p exits 1
    // having produced only Claude Code's own model error, which used to read as an opaque "error".
    const o: SessionOutcome = {
      status: "failed",
      exitCode: 1,
      outputTail:
        "⚠️ There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it.",
    };
    expect(classifyFailure(o)).toBe("model");
  });

  it("classifies an API model_not_found error as a model misconfig", () => {
    expect(
      classifyFailure({ status: "failed", exitCode: 1, outputTail: "404 model_not_found" }),
    ).toBe("model");
  });

  it("a genuine auth error still wins over the model bucket", () => {
    // Defense in depth: an unauthorized error mentioning a model must still route to auth (owner reconnects).
    expect(
      classifyFailure({
        status: "failed",
        exitCode: 1,
        outputTail: "unauthorized: invalid api key for the selected model",
      }),
    ).toBe("auth");
  });

  it("classifies a self-reported startup failure as spawn even on a clean (exit 0) process (#319)", () => {
    // The board bug: claude BOOTS, can't find a tool, reports it to the user and exits 0 — neither the
    // exit code nor an is_error event flags it. The content names a startup failure → spawn copy, not error.
    expect(
      classifyFailure({
        status: "failed",
        exitCode: 0,
        outputTail: "I couldn't start up — my runtime is missing a tool I need (spawn).",
      }),
    ).toBe("spawn");
  });

  it("does NOT misread a deliverable that merely mentions a missing tool as a startup failure (#319)", () => {
    // A real artifact that discusses tools is still an error/normal bucket, never the boot-failure copy.
    expect(
      classifyFailure({
        status: "failed",
        exitCode: 2,
        outputTail: "Our launch thread covers the tool we were missing last quarter. boom",
      }),
    ).toBe("error");
  });
});

describe("looksLikeStartupFailure (#319)", () => {
  it("matches the agent's own boot-failure wording", () => {
    expect(looksLikeStartupFailure("I could not start up - my runtime is missing a tool I need (spawn).")).toBe(true);
    expect(looksLikeStartupFailure("I couldn't start up. Something went wrong.")).toBe(true);
    expect(looksLikeStartupFailure("Unable to start up: missing dependency.")).toBe(true);
  });

  it("is false for a genuine artifact and for empty text", () => {
    expect(looksLikeStartupFailure("Here are 5 tweets for the launch thread.")).toBe(false);
    expect(looksLikeStartupFailure("")).toBe(false);
    expect(looksLikeStartupFailure(undefined)).toBe(false);
  });

  it("only inspects the HEAD — a late, incidental mention does not trip it", () => {
    const longArtifact = "A real, complete launch thread. ".repeat(40) + "could not start up";
    expect(looksLikeStartupFailure(longArtifact)).toBe(false);
  });
});

describe("decideSessionDisposition (#319 / #251 / #200)", () => {
  it("a real, output-bearing clean completion is DONE", () => {
    const d = decideSessionDisposition({
      status: "completed",
      exitCode: 0,
      harnessReportedError: false,
      artifact: "Here are 5 tweets ready to post.",
    });
    expect(d).toEqual({ status: "completed", done: true, failureClass: null });
  });

  it("a clean exit whose stream ended in a harness error is FAILED, not done (#251)", () => {
    const d = decideSessionDisposition({
      status: "completed",
      exitCode: 0,
      harnessReportedError: true,
      artifact: "I couldn't complete the task — I'm missing a tool I need.",
    });
    expect(d.status).toBe("failed");
    expect(d.done).toBe(false);
  });

  it("a clean exit whose OUTPUT is a self-reported startup failure is FAILED with spawn class (#319)", () => {
    // THE board bug: a 'done/shipped' card whose entire content is "I couldn't start up". Never done.
    const d = decideSessionDisposition({
      status: "completed",
      exitCode: 0,
      harnessReportedError: false,
      artifact: "I couldn't start up — my runtime is missing a tool I need (spawn).",
    });
    expect(d.status).toBe("failed");
    expect(d.done).toBe(false);
    expect(d.failureClass).toBe("spawn");
  });

  it("a true spawn failure (no exit code) is FAILED with spawn class", () => {
    const d = decideSessionDisposition({
      status: "failed",
      exitCode: null,
      harnessReportedError: false,
      artifact: "",
    });
    expect(d).toEqual({ status: "failed", done: false, failureClass: "spawn" });
  });

  it("a clean exit with NO output is completed but NOT done (preserves prior no-deliverable behavior)", () => {
    // An empty result is not a hard failure (it booted + exited cleanly) but there is nothing to surface,
    // so it never becomes a deliverable/shipped card — exactly today's behavior, now expressed in one place.
    const d = decideSessionDisposition({
      status: "completed",
      exitCode: 0,
      harnessReportedError: false,
      artifact: "   ",
    });
    expect(d.status).toBe("completed");
    expect(d.done).toBe(false);
    expect(d.failureClass).toBeNull();
  });

  it("a non-zero exit is FAILED and never done, regardless of output", () => {
    const d = decideSessionDisposition({
      status: "failed",
      exitCode: 1,
      harnessReportedError: false,
      artifact: "boom",
    });
    expect(d.done).toBe(false);
    expect(d.failureClass).toBe("error");
  });

  it("a timeout/canceled status is surfaced with its own class and is never done", () => {
    expect(
      decideSessionDisposition({ status: "timeout", exitCode: null, harnessReportedError: false, artifact: "" }),
    ).toEqual({ status: "timeout", done: false, failureClass: "timeout" });
    expect(
      decideSessionDisposition({ status: "canceled", exitCode: null, harnessReportedError: false, artifact: "" }),
    ).toEqual({ status: "canceled", done: false, failureClass: "canceled" });
  });
});

describe("renderSessionOutcome (#166)", () => {
  it("renders a green check ONLY for a clean completion", () => {
    const msg = renderSessionOutcome({ status: "completed", exitCode: 0 });
    expect(msg).toContain("✅");
    expect(msg).toContain("session completed");
  });

  it("never renders a green check for a spawn failure — failure mark + reason class instead", () => {
    const msg = renderSessionOutcome({ status: "failed", exitCode: null });
    expect(msg).not.toContain("✅");
    expect(msg).toContain("❌");
    expect(msg.toLowerCase()).toContain("spawn");
    // Honest debug footer keeps the raw status + exit the old line exposed.
    expect(msg).toContain("failed");
    expect(msg).toContain("n/a");
  });

  it("never renders a green check for a timeout", () => {
    const msg = renderSessionOutcome({ status: "timeout", exitCode: null });
    expect(msg).not.toContain("✅");
    expect(msg).toContain("❌");
    expect(msg.toLowerCase()).toContain("timeout");
  });

  it("surfaces an auth reason the owner can act on", () => {
    const msg = renderSessionOutcome({
      status: "failed",
      exitCode: 1,
      outputTail: "invalid api key — run claude /login",
    });
    expect(msg).not.toContain("✅");
    expect(msg.toLowerCase()).toContain("auth");
    expect(msg).toContain("Connect Claude");
  });

  it("surfaces a model-misconfig reason the owner can act on instead of an opaque error (#242)", () => {
    const msg = renderSessionOutcome({
      status: "failed",
      exitCode: 1,
      outputTail:
        "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it.",
    });
    expect(msg).not.toContain("✅");
    expect(msg).toContain("❌");
    expect(msg.toLowerCase()).toContain("model");
    expect(msg).toContain("Settings → Model");
    // Honest debug footer still carries the raw status + exit, but never the model name from the tail.
    expect(msg).toContain("exit 1");
    expect(msg).not.toContain("claude-fable-5");
  });

  it("never echoes the raw output tail (no secret leakage) into the rendered message", () => {
    const secret = "sk-ant-oat-SECRETTOKENVALUE";
    const msg = renderSessionOutcome({
      status: "failed",
      exitCode: 1,
      outputTail: `auth error token=${secret}`,
    });
    expect(msg).not.toContain(secret);
  });
});

/**
 * #393 — the agent's deliverable, formatted as the chat reply it posts back into its channel. Without
 * this the work landed only on a board card and the owner read the channel as "no response". The pure
 * formatter trims, strips control chars (keeping newlines/tabs — a deliverable is multi-line), and caps
 * the length; a blank deliverable returns "" so the caller skips posting.
 */
describe("formatDeliverableMessage (#393)", () => {
  it("returns the trimmed deliverable as the reply body", () => {
    expect(formatDeliverableMessage("audit homepage SEO", "  add a meta description to /pricing.  ")).toBe(
      "add a meta description to /pricing.",
    );
  });

  it("returns '' for a blank deliverable so the caller skips posting", () => {
    expect(formatDeliverableMessage("any task", "")).toBe("");
    expect(formatDeliverableMessage("any task", "   \n\t  ")).toBe("");
  });

  it("PRESERVES newlines and tabs (a deliverable is multi-line — never collapsed)", () => {
    const multiline = "Line one\nLine two\n\t- bullet";
    expect(formatDeliverableMessage("task", multiline)).toBe(multiline);
  });

  it("strips C0/C1 control characters but keeps the readable text", () => {
    const withControls = `hello${String.fromCharCode(0)}${String.fromCharCode(7)}${String.fromCharCode(0x9b)}world`;
    expect(formatDeliverableMessage("task", withControls)).toBe("helloworld");
  });

  it("caps the body at MAX_REPLY_CHARS", () => {
    const long = "x".repeat(MAX_REPLY_CHARS + 500);
    const out = formatDeliverableMessage("task", long);
    expect(out).toHaveLength(MAX_REPLY_CHARS);
  });
});
