import { describe, it, expect } from "vitest";
import {
  classifyFailure,
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
