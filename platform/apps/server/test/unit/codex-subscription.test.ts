import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexStatusFromDoctor,
  createCodexSubscriptionStatusProvider,
  materializeCodexAuthJson,
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

  it("materializes CODEX_AUTH_JSON into the Codex auth file used by doctor and exec", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "ipop-codex-home-"));
    const authJson = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "redacted", refresh_token: "redacted" },
    });

    await expect(materializeCodexAuthJson(authJson, codexHome)).resolves.toBe(true);

    const authPath = join(codexHome, "auth.json");
    await expect(readFile(authPath, "utf8")).resolves.toBe(authJson);
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  });

  it("skips auth-file writes when CODEX_AUTH_JSON is absent", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "ipop-codex-home-"));
    await expect(materializeCodexAuthJson(null, codexHome)).resolves.toBe(false);
  });

  it("materializes auth before the default doctor provider runs codex", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "ipop-codex-home-"));
    const bin = join(codexHome, "codex-fake.mjs");
    const authJson = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "redacted", refresh_token: "redacted" },
    });
    await writeFile(
      bin,
      [
        "#!/usr/bin/env node",
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const auth = JSON.parse(readFileSync(join(process.env.CODEX_HOME, 'auth.json'), 'utf8'));",
        "if (auth.auth_mode !== 'chatgpt') process.exit(2);",
        "process.stdout.write(" + JSON.stringify(JSON.stringify(JSON.parse(doctor()))) + ");",
      ].join("\n"),
    );
    await chmod(bin, 0o700);

    const provider = createCodexSubscriptionStatusProvider({ authJson, codexBin: bin, codexHome });

    await expect(provider.status()).resolves.toMatchObject({
      connected: true,
      runtimeAuth: "signed_in_subscription",
    });
  });
});
