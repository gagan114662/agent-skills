import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/env.js";

describe("loadEnv — approval expiry sweep (#951)", () => {
  it("keeps the approval-expiry background sweep disabled by default", () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.approval.sweepIntervalMs).toBe(0);
  });

  it("parses APPROVAL_SWEEP_INTERVAL_MS when the deployment opts in", () => {
    const env = loadEnv({ APPROVAL_SWEEP_INTERVAL_MS: "60000" } as NodeJS.ProcessEnv);
    expect(env.approval.sweepIntervalMs).toBe(60_000);
  });
});
