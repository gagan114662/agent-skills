import { describe, expect, it, vi } from "vitest";
import { fingerprintFailure } from "../../src/flywheel/fingerprint.js";
import {
  loopFailureEvent,
  recordLoopWorkspaceFailure,
} from "../../src/observability/loop-failures.js";

describe("loop failure flywheel events", () => {
  it("normalizes recurring workspace tick failures to the same flywheel fingerprint", () => {
    const first = loopFailureEvent({
      loop: "watchdog",
      workspaceId: "ws_1",
      err: new Error(
        "Redis timeout for session 018cf1b2-7a9d-41da-9104-a0f703e72c6e at 2026-06-24T18:00:00Z",
      ),
    });
    const second = loopFailureEvent({
      loop: "watchdog",
      workspaceId: "ws_1",
      err: new Error(
        "Redis timeout for session 51a07421-df36-47a1-9b50-f66e3c7d103f at 2026-06-24T18:05:00Z",
      ),
    });

    expect(first).toMatchObject({
      workspaceId: "ws_1",
      failureClass: "watchdog_revival",
      source: "loop:watchdog",
    });
    expect(fingerprintFailure(first).signature).toBe(fingerprintFailure(second).signature);
  });

  it("does not throw when the recorder is unavailable", async () => {
    const recorder = vi.fn(async () => {
      throw new Error("flywheel store unavailable");
    });

    await expect(
      recordLoopWorkspaceFailure({
        recorder,
        loop: "sre",
        workspaceId: "ws_1",
        err: new Error("metrics read failed"),
      }),
    ).resolves.toBeUndefined();
  });
});
