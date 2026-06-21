import { describe, it, expect } from "vitest";
import { redactTracePayload, SENSITIVE_KEY_MASK } from "../../src/trace/redact.js";
import { REDACTION_MASK } from "../../src/runtime/redact.js";

/**
 * Issue #560: a trace must never become a secret-exfil channel. Every event payload is redacted at the
 * write site two ways before it is persisted: (1) known secret VALUES are masked everywhere they appear
 * (reusing the #25 runtime/redact.ts redactor), and (2) sensitive KEYS (authorization, api_key, token…)
 * are masked regardless of value, defense-in-depth for secrets we were never told about.
 */
describe("redactTracePayload", () => {
  it("masks known secret values wherever they appear, at any depth", () => {
    const out = redactTracePayload(
      {
        messages: [{ role: "user", content: "my key is sk-live-ABC123XYZ please use it" }],
        env: { DEPLOY: "token=sk-live-ABC123XYZ" },
      },
      ["sk-live-ABC123XYZ"],
    );
    const json = JSON.stringify(out);
    expect(json).not.toContain("sk-live-ABC123XYZ");
    expect(json).toContain(REDACTION_MASK);
  });

  it("masks sensitive keys regardless of value", () => {
    const out = redactTracePayload(
      {
        headers: { Authorization: "Bearer abcdef123456", "content-type": "application/json" },
        config: { apiKey: "zzz-unknown-secret", region: "us-east-1" },
        password: "hunter2hunter2",
      },
      [],
    ) as { headers: Record<string, string>; config: Record<string, string>; password: string };
    expect(out.headers.Authorization).toBe(SENSITIVE_KEY_MASK);
    expect(out.headers["content-type"]).toBe("application/json");
    expect(out.config.apiKey).toBe(SENSITIVE_KEY_MASK);
    expect(out.config.region).toBe("us-east-1");
    expect(out.password).toBe(SENSITIVE_KEY_MASK);
  });

  it("is pure — does not mutate the input object", () => {
    const input = { a: { b: "sk-secret-value" } };
    const copy = JSON.parse(JSON.stringify(input));
    redactTracePayload(input, ["sk-secret-value"]);
    expect(input).toEqual(copy);
  });

  it("handles arrays, nulls, numbers and booleans without throwing", () => {
    const out = redactTracePayload(
      { list: [1, true, null, "secret-abc", { api_key: "x" }], n: 42, ok: false },
      ["secret-abc"],
    ) as { list: unknown[]; n: number; ok: boolean };
    expect(out.list[0]).toBe(1);
    expect(out.list[1]).toBe(true);
    expect(out.list[2]).toBe(null);
    expect(out.list[3]).toBe(REDACTION_MASK);
    expect((out.list[4] as Record<string, string>).api_key).toBe(SENSITIVE_KEY_MASK);
    expect(out.n).toBe(42);
    expect(out.ok).toBe(false);
  });

  it("does NOT mask token-count keys (input_tokens/max_tokens) — they are legitimate trace data", () => {
    const out = redactTracePayload(
      { usage: { input_tokens: 100, output_tokens: 50 }, max_tokens: 4096 },
      [],
    ) as { usage: Record<string, number>; max_tokens: number };
    expect(out.usage.input_tokens).toBe(100);
    expect(out.usage.output_tokens).toBe(50);
    expect(out.max_tokens).toBe(4096);
  });

  it("caps very long strings so a payload can't store an unbounded blob", () => {
    const out = redactTracePayload({ blob: "x".repeat(50_000) }, []) as { blob: string };
    expect(out.blob.length).toBeLessThan(50_000);
    expect(out.blob).toContain("…");
  });
});
