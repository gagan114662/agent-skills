import { describe, it, expect } from "vitest";
import { buildCapture, inputByteLength, redactInputs } from "../../src/run-replay/capture.js";
import { fingerprint } from "../../src/run-replay/fingerprint.js";
import type { RunInputs } from "../../src/run-replay/types.js";

const INPUTS: RunInputs = {
  prompt: "summarize the report",
  seed: 42,
  config: { model: "claude-opus-4-8", temperature: 0 },
  env: { REGION: "us-east-1" },
};

describe("redactInputs", () => {
  it("masks values held under sensitive keys in config and env", () => {
    const out = redactInputs({
      ...INPUTS,
      config: { model: "m", api_key: "sk-secret" },
      env: { authorization: "Bearer abc", REGION: "us" },
    });
    expect(out.config.api_key).not.toBe("sk-secret");
    expect(out.env.authorization).not.toContain("Bearer abc");
    // non-sensitive values pass through untouched
    expect(out.config.model).toBe("m");
    expect(out.env.REGION).toBe("us");
  });

  it("scrubs known secret values wherever they appear, including the prompt", () => {
    const out = redactInputs(
      { ...INPUTS, prompt: "use token sk-live-123 now", config: { note: "sk-live-123" } },
      ["sk-live-123"],
    );
    expect(out.prompt).not.toContain("sk-live-123");
    expect(out.config.note).not.toContain("sk-live-123");
  });

  it("leaves the numeric seed intact", () => {
    expect(redactInputs(INPUTS).seed).toBe(42);
  });

  it("does not mutate the input", () => {
    const original = JSON.parse(JSON.stringify(INPUTS));
    redactInputs(INPUTS, ["whatever"]);
    expect(INPUTS).toEqual(original);
  });
});

describe("buildCapture", () => {
  it("produces a running capture whose fingerprint is reproducible from the stored inputs", () => {
    const cap = buildCapture({ runId: "r1", workspaceId: "ws1", inputs: INPUTS, capturedAtMs: 1000 });
    expect(cap.status).toBe("running");
    expect(cap.outcome).toBeNull();
    expect(cap.endedAtMs).toBeNull();
    expect(cap.replayOf).toBeNull();
    expect(cap.capturedAtMs).toBe(1000);
    // re-fingerprinting the (redacted) stored inputs yields the stored fingerprint — integrity check
    expect(fingerprint(cap.inputs)).toBe(cap.inputsFingerprint);
  });

  it("fingerprints over the redacted inputs, so secrets never affect the hash", () => {
    const clean = buildCapture({
      runId: "r1",
      workspaceId: "ws1",
      inputs: { ...INPUTS, config: { model: "m", api_key: "REDACTED-MASK" } },
      capturedAtMs: 1,
    });
    const withSecret = buildCapture(
      {
        runId: "r2",
        workspaceId: "ws1",
        inputs: { ...INPUTS, config: { model: "m", api_key: "sk-secret" } },
        capturedAtMs: 1,
      },
      [],
    );
    // both api_key values are masked under the sensitive-key rule → identical redacted inputs → same hash
    expect(withSecret.inputsFingerprint).toBe(clean.inputsFingerprint);
  });

  it("records replayOf when this capture is itself a replay", () => {
    const cap = buildCapture({
      runId: "r2",
      workspaceId: "ws1",
      inputs: INPUTS,
      replayOf: "r1",
      capturedAtMs: 2,
    });
    expect(cap.replayOf).toBe("r1");
  });
});

describe("inputByteLength", () => {
  it("measures the canonical byte size of the inputs", () => {
    expect(inputByteLength(INPUTS)).toBeGreaterThan(0);
    const big = { ...INPUTS, prompt: "x".repeat(10_000) };
    expect(inputByteLength(big)).toBeGreaterThan(inputByteLength(INPUTS));
  });
});
