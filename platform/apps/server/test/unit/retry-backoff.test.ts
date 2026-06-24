import { describe, expect, it, vi } from "vitest";
import { retryWithBackoff } from "../../src/reliability/retry-backoff.js";

describe("retryWithBackoff", () => {
  it("backs off between retryable failures and returns the successful value", async () => {
    const sleeps: number[] = [];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("try again"))
      .mockRejectedValueOnce(new Error("try again"))
      .mockResolvedValue("ok");

    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).resolves.toBe("ok");

    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([10, 20]);
  });

  it("stops immediately when the retry predicate rejects the error", async () => {
    const fn = vi.fn(async () => {
      throw new Error("permanent");
    });

    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 3,
        shouldRetry: () => false,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("permanent");

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

