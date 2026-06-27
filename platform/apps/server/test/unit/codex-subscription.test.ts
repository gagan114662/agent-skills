import { describe, expect, it } from "vitest";
import {
  codexStatusFromDoctor,
  createCodexSubscriptionStatusProvider,
} from "../../src/runtime/codex-subscription.js";

function doctor(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    checks: {
      "auth.credentials": {
        status: "ok",
        details: {
          "stored auth mode": "chatgpt",
          "stored ChatGPT tokens": "true",
          "stored API key": "false",
        },
      },
      "network.websocket_reachability": {
        status: "ok",
        details: {
          "auth mode": "chatgpt",
          "provider name": "OpenAI",
        },
      },
      // A non-auth doctor failure must not block subscription-backed non-interactive agent runs.
      "terminal.env": { status: "fail", details: { TERM: "dumb" } },
      ...overrides,
    },
  });
}

describe("Codex subscription status (#1282)", () => {
  it("treats ChatGPT token auth plus websocket reachability as signed-in subscription auth", () => {
    expect(codexStatusFromDoctor(doctor())).toMatchObject({
      connected: true,
      selectedHarness: "codex",
      runtimeAuth: "signed_in_subscription",
      fallback: "none",
      apiKeySatisfies: false,
    });
  });

  it("fails closed when doctor does not prove ChatGPT subscription auth", () => {
    expect(
      codexStatusFromDoctor(
        doctor({
          "auth.credentials": {
            status: "ok",
            details: {
              "stored auth mode": "api-key",
              "stored ChatGPT tokens": "false",
              "stored API key": "true",
            },
          },
        }),
      ),
    ).toMatchObject({
      connected: false,
      runtimeAuth: "missing",
      fallback: "none",
      apiKeySatisfies: false,
    });
  });

  it("fails closed instead of throwing when doctor JSON is null or another non-object", () => {
    expect(codexStatusFromDoctor("null")).toMatchObject({
      connected: false,
      reason: "Codex doctor did not return a valid JSON report object.",
    });
    expect(codexStatusFromDoctor("[]")).toMatchObject({
      connected: false,
      reason: "Codex doctor did not return a valid JSON report object.",
    });
  });

  it("uses JSON stdout from a non-zero doctor exit so unrelated doctor failures do not block runs", async () => {
    const err = Object.assign(new Error("doctor exited 1"), { stdout: doctor() });
    const provider = createCodexSubscriptionStatusProvider({
      runDoctor: async () => {
        throw err;
      },
    });
    await expect(provider.status()).resolves.toMatchObject({
      connected: true,
      runtimeAuth: "signed_in_subscription",
      apiKeySatisfies: false,
    });
  });

  it("deduplicates concurrent doctor checks so status polling cannot stampede processes", async () => {
    let calls = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = createCodexSubscriptionStatusProvider({
      runDoctor: async () => {
        calls += 1;
        await ready;
        return doctor();
      },
    });

    const first = provider.status();
    const second = provider.status();
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ connected: true }),
      expect.objectContaining({ connected: true }),
    ]);
    expect(calls).toBe(1);
  });
});
