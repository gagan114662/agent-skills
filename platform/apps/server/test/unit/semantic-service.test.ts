import { describe, it, expect } from "vitest";
import { SemanticLayerService, type MetricResolver } from "../../src/semantic/service.js";
import { FLEET_DEFAULTS } from "../../src/semantic/caps.js";

/** The semantic service over a fake resolver (#155): one number, provenance + freshness, raw fallback. */

function build(resolve: MetricResolver["resolve"]) {
  return new SemanticLayerService({
    resolver: { resolve },
    caps: () => FLEET_DEFAULTS,
    now: () => new Date(1_000_000),
  });
}

describe("SemanticLayerService (#155)", () => {
  it("returns the catalog", () => {
    const svc = build(async () => ({ value: 1, asOfMs: null, path: "semantic_layer" }));
    expect(svc.catalog().some((m) => m.id === "growth.score")).toBe(true);
  });

  it("answers a known metric through the canonical path, citing provenance", async () => {
    const svc = build(async () => ({ value: 72, asOfMs: 1_000_000 - 1000, path: "semantic_layer" }));
    const ans = await svc.answer("ws1", "growth.score");
    expect(ans).not.toBeNull();
    expect(ans!.value).toBe(72);
    expect(ans!.fallback).toBe(false);
    expect(ans!.spoken).toContain("semantic layer (canonical)");
  });

  it("returns null for an unknown metric id (route → 404)", async () => {
    const svc = build(async () => ({ value: 0, asOfMs: null, path: "semantic_layer" }));
    expect(await svc.answer("ws1", "no.such.metric")).toBeNull();
  });

  it("flags a raw-data fallback when the resolver has no governed number", async () => {
    const svc = build(async () => ({ value: null, asOfMs: null, path: "raw_data" }));
    const ans = await svc.answer("ws1", "venture.score");
    expect(ans!.fallback).toBe(true);
    expect(ans!.spoken).toContain("No governed number");
  });

  it("answerAll covers the whole catalog (one resolve per metric)", async () => {
    let calls = 0;
    const svc = build(async () => {
      calls += 1;
      return { value: 1, asOfMs: 1_000_000, path: "semantic_layer" };
    });
    const all = await svc.answerAll("ws1");
    expect(all.length).toBe(svc.catalog().length);
    expect(calls).toBe(svc.catalog().length);
  });
});
