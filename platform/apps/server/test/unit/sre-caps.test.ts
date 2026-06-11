import { describe, it, expect } from "vitest";
import { resolveSreCaps, SRE_DEFAULTS } from "../../src/sre/caps.js";

describe("resolveSreCaps", () => {
  it("is default OFF with no services when config is absent", () => {
    const caps = resolveSreCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps.services).toEqual([]);
    expect(caps.cooldownMs).toBe(SRE_DEFAULTS.cooldownMs);
  });

  it("builds one SLO target per declared dimension, skipping omitted ones", () => {
    const caps = resolveSreCaps({
      enabled: true,
      cooldownMs: 60_000,
      services: [
        { service: "api", availabilityTarget: 0.999, latencyP95Ms: 500 },
        { service: "redis", availabilityTarget: 1 },
      ],
    });
    expect(caps.enabled).toBe(true);
    expect(caps.cooldownMs).toBe(60_000);

    const api = caps.services.find((s) => s.service === "api")!;
    expect(api.targets.map((t) => t.kind).sort()).toEqual(["availability", "latency_p95"]);
    expect(api.targets.find((t) => t.kind === "availability")!.target).toBe(0.999);
    expect(api.targets.find((t) => t.kind === "latency_p95")!.target).toBe(500);

    const redis = caps.services.find((s) => s.service === "redis")!;
    expect(redis.targets).toHaveLength(1);
    expect(redis.targets[0].kind).toBe("availability");
  });

  it("drops services that declare no SLO dimension", () => {
    const caps = resolveSreCaps({ enabled: true, services: [{ service: "empty" }] });
    expect(caps.services).toHaveLength(0);
  });
});
