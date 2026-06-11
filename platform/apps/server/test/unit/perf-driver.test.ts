import { describe, it, expect } from "vitest";
import { runLoad } from "../../src/perf/driver.js";

describe("runLoad (the closed-loop load driver)", () => {
  it("issues exactly totalRequests and reports them", async () => {
    let calls = 0;
    const res = await runLoad(
      { name: "scn", totalRequests: 50, concurrency: 5 },
      async () => {
        calls += 1;
        return { ok: true };
      },
    );
    expect(calls).toBe(50);
    expect(res.requests).toBe(50);
    expect(res.name).toBe("scn");
  });

  it("never exceeds the configured concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    await runLoad({ name: "scn", totalRequests: 60, concurrency: 8 }, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      await Promise.resolve();
      active -= 1;
      return { ok: true };
    });
    expect(maxActive).toBeLessThanOrEqual(8);
    expect(maxActive).toBeGreaterThan(1); // it actually parallelized
  });

  it("counts failures (both !ok results and thrown errors) into the error rate", async () => {
    let n = 0;
    const res = await runLoad({ name: "scn", totalRequests: 10, concurrency: 2 }, async () => {
      n += 1;
      if (n % 2 === 0) throw new Error("boom");
      return { ok: n % 3 !== 0 }; // some explicit !ok too
    });
    expect(res.requests).toBe(10);
    expect(res.errors).toBeGreaterThan(0);
    expect(res.errorRate).toBeCloseTo(res.errors / res.requests, 5);
  });

  it("derives throughput + latency stats from an injected clock (deterministic)", async () => {
    // Clock advances 1ms per call; before/after bracket each request → ~1ms latency samples.
    let t = 0;
    const clock = () => (t += 1);
    const res = await runLoad(
      { name: "scn", totalRequests: 4, concurrency: 1 },
      async () => ({ ok: true }),
      clock,
    );
    expect(res.requests).toBe(4);
    expect(res.durationMs).toBeGreaterThan(0);
    expect(res.rps).toBeGreaterThan(0);
    expect(res.p50Ms).toBeGreaterThanOrEqual(0);
    expect(res.p99Ms).toBeGreaterThanOrEqual(res.p50Ms);
  });

  it("returns a clean zero-error result on a fully-healthy run", async () => {
    const res = await runLoad({ name: "ok", totalRequests: 20, concurrency: 4 }, async () => ({
      ok: true,
    }));
    expect(res.errors).toBe(0);
    expect(res.errorRate).toBe(0);
  });
});
