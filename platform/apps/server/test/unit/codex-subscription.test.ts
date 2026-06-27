import { describe, expect, it } from "vitest";
import { codexStatusFromDoctor } from "../../src/runtime/codex-subscription.js";

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
});
