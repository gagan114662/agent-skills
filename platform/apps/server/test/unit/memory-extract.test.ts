import { describe, it, expect } from "vitest";
import {
  DeterministicExtractor,
  LlmExtractor,
  type Extraction,
  type MemoryExtractor,
} from "../../src/memory/extract.js";
import { planCapture } from "../../src/memory/capture.js";

describe("DeterministicExtractor (issue #15 — default fallback)", () => {
  const ex = new DeterministicExtractor();

  it("classifies the four canonical types from lexical cues", async () => {
    const text = [
      "We decided to use Postgres for storage",
      "The API runs on port 3000",
      "I prefer tabs over spaces",
      "See the diagram at https://example.com/arch.png",
    ].join("\n");
    const out = await ex.extract({ text });
    expect(out.memories.map((m) => m.type)).toEqual([
      "decision",
      "fact",
      "preference",
      "artifact",
    ]);
  });

  it("pulls an entity from a leading #tag", async () => {
    const out = await ex.extract({ text: "#auth tokens expire after an hour" });
    expect(out.memories[0]?.entity).toBe("auth");
  });

  it("yields nodes AND edges for a multi-statement source (each later node relates_to the anchor)", async () => {
    const out = await ex.extract({
      text: "We decided to ship daily\nCI runs on every push",
    });
    expect(out.memories).toHaveLength(2);
    expect(out.edges).toEqual([{ fromIndex: 1, toIndex: 0, relation: "relates_to" }]);
  });

  it("a single statement yields one node and no edges", async () => {
    const out = await ex.extract({ text: "The build is green" });
    expect(out.memories).toHaveLength(1);
    expect(out.edges).toHaveLength(0);
  });
});

describe("LlmExtractor (issue #15 — LLM-assisted behind an interface)", () => {
  it("delegates to the injected client and parses its JSON extraction", async () => {
    const canned: Extraction = {
      memories: [{ type: "decision", text: "adopt OTel", entity: "observability" }],
      edges: [],
    };
    const extractor = new LlmExtractor({ complete: async () => JSON.stringify(canned) });
    const out = await extractor.extract({ text: "anything" });
    expect(out).toEqual(canned);
  });

  it("falls back to an empty extraction when the client returns unparseable output", async () => {
    const extractor = new LlmExtractor({ complete: async () => "not json" });
    expect(await extractor.extract({ text: "x" })).toEqual({ memories: [], edges: [] });
  });
});

describe("planCapture (issue #15 — pluggable extraction, DB-free)", () => {
  it("computes a dedup key per node and keeps only valid edges", async () => {
    // A stub extractor proves extraction is pluggable without any real classifier.
    const stub: MemoryExtractor = {
      extract: async (): Promise<Extraction> => ({
        memories: [
          { type: "decision", text: "A" },
          { type: "fact", text: "B" },
        ],
        edges: [
          { fromIndex: 1, toIndex: 0, relation: "supports" },
          { fromIndex: 0, toIndex: 0, relation: "self" }, // dropped: self-loop
          { fromIndex: 9, toIndex: 0, relation: "dangling" }, // dropped: out of range
        ],
      }),
    };
    const plan = planCapture(await stub.extract({ text: "" }));
    expect(plan.nodes).toHaveLength(2);
    expect(plan.nodes[0]?.dedupeKey).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.edges).toEqual([{ fromIndex: 1, toIndex: 0, relation: "supports" }]);
  });
});
