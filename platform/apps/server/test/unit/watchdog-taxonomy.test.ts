import { describe, it, expect } from "vitest";
import { classifyFailure } from "../../src/watchdog/taxonomy.js";

/**
 * The pure failure taxonomy (#105 acceptance #3). Maps a session's status (+ exit code) to a class
 * and a `retryable` flag the watchdog persists and feeds to `decideRevival`, so it "learns which
 * errors are retryable" and never retries a permanently-broken session forever.
 */
describe("classifyFailure", () => {
  it("classifies a non-terminal stall as retryable (the network-blip premortem case)", () => {
    expect(classifyFailure("running")).toEqual({ class: "stalled", retryable: true });
    expect(classifyFailure("provisioning")).toEqual({ class: "stalled", retryable: true });
  });

  it("classifies a wall-clock timeout as retryable", () => {
    expect(classifyFailure("timeout")).toEqual({ class: "timeout", retryable: true });
  });

  it("classifies an idle-reap as retryable", () => {
    expect(classifyFailure("idle_reaped")).toEqual({ class: "idle", retryable: true });
  });

  it("classifies a crash with no exit code (process died — likely a blip) as retryable", () => {
    expect(classifyFailure("failed", null)).toEqual({ class: "crashed", retryable: true });
  });

  it("classifies a non-zero exit (the agent itself errored out) as NON-retryable", () => {
    expect(classifyFailure("failed", 1)).toEqual({ class: "crashed", retryable: false });
  });

  it("classifies a human cancel as NON-retryable (never revive what a human stopped)", () => {
    expect(classifyFailure("canceled")).toEqual({ class: "canceled", retryable: false });
  });

  it("classifies a completed session as NON-retryable (nothing to revive)", () => {
    expect(classifyFailure("completed")).toEqual({ class: "completed", retryable: false });
  });
});
