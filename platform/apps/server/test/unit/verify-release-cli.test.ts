import { describe, it, expect } from "vitest";
import { verifyReleaseLive } from "../../src/runtime/verify-release-cli.js";

/**
 * #292 — the post-deploy gate that probes the LIVE host and asserts it serves the deployed commit. The
 * pure verdict is covered in release-verify.test.ts; here we pin the IO orchestration (retry budget, early
 * success, and the fail-closed behavior when the probe errors or never matches) with an injected probe so
 * no network or real wait is involved.
 */
const full = "0123456789abcdef0123456789abcdef01234567";

describe("verifyReleaseLive (#292 — retry, early success, fail-closed)", () => {
  it("returns advanced as soon as the live host reports the deployed commit, without exhausting attempts", async () => {
    let calls = 0;
    const verdict = await verifyReleaseLive({
      expectedSha: full,
      probe: () => {
        calls += 1;
        return Promise.resolve(full);
      },
      attempts: 10,
      sleep: () => Promise.resolve(),
      log: () => undefined,
    });
    expect(verdict.advanced).toBe(true);
    expect(calls).toBe(1); // matched on first probe — no needless retries
  });

  it("retries while the host still reports the OLD commit, then succeeds once it cuts over", async () => {
    const old = "fedcba9876543210fedcba9876543210fedcba98";
    const seq = [old, old, full];
    let i = 0;
    let slept = 0;
    const verdict = await verifyReleaseLive({
      expectedSha: full,
      probe: () => Promise.resolve(seq[i++] ?? null),
      attempts: 5,
      sleep: () => {
        slept += 1;
        return Promise.resolve();
      },
      log: () => undefined,
    });
    expect(verdict.advanced).toBe(true);
    expect(slept).toBe(2); // slept between the two old reads, not after the match
  });

  it("fails closed when the host never advances within the attempt budget", async () => {
    const old = "fedcba9876543210fedcba9876543210fedcba98";
    let calls = 0;
    const verdict = await verifyReleaseLive({
      expectedSha: full,
      probe: () => {
        calls += 1;
        return Promise.resolve(old);
      },
      attempts: 3,
      sleep: () => Promise.resolve(),
      log: () => undefined,
    });
    expect(verdict.advanced).toBe(false);
    expect(calls).toBe(3);
    expect(verdict.reason).toMatch(/did NOT advance/);
  });

  it("treats a throwing/unreachable probe as 'unknown' (fail-closed), never a pass", async () => {
    const verdict = await verifyReleaseLive({
      expectedSha: full,
      probe: () => Promise.reject(new Error("ECONNREFUSED")),
      attempts: 2,
      sleep: () => Promise.resolve(),
      log: () => undefined,
    });
    expect(verdict.advanced).toBe(false);
    expect(verdict.live).toBeNull();
  });
});
