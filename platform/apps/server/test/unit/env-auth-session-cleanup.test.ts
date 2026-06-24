import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/env.js";

describe("loadEnv — auth session cleanup (#960)", () => {
  it("enables expired-session cleanup by default", () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.authSessionCleanup).toEqual({ intervalMs: 3_600_000, batchSize: 1_000 });
  });

  it("parses interval and batch overrides", () => {
    const env = loadEnv({
      AUTH_SESSION_CLEANUP_INTERVAL_MS: "300000",
      AUTH_SESSION_CLEANUP_BATCH_SIZE: "250",
    } as NodeJS.ProcessEnv);
    expect(env.authSessionCleanup).toEqual({ intervalMs: 300_000, batchSize: 250 });
  });
});
