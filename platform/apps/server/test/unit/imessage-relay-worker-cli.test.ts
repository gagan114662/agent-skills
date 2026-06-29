import { describe, expect, it, vi } from "vitest";
import { parseRelayWorkerConfig, runRelayDoctor } from "../../src/imessage/relay-worker-cli.js";

describe("iMessage relay worker CLI (#1341)", () => {
  it("requires a logged-in macOS host unless explicitly allowed for tests", () => {
    expect(() =>
      parseRelayWorkerConfig({
        env: { IMESSAGE_RELAY_WEBHOOK_SECRET: "secret" },
        platform: "linux",
        host: "fly-host",
      }),
    ).toThrow(/macOS host/i);
  });

  it("parses the signed Mac relay config", () => {
    const config = parseRelayWorkerConfig({
      argv: ["--doctor", "--once"],
      env: {
        IMESSAGE_RELAY_WEBHOOK_SECRET: "SECRET_RELAY",
        IMESSAGE_RELAY_API_BASE: "https://api.ipop.ai",
        IMESSAGE_RELAY_ID: "gagan-mac",
        IMESSAGE_RELAY_VERSION: "v1",
        IMESSAGE_RELAY_CLAIM_LIMIT: "7",
        IMESSAGE_RELAY_LEASE_MS: "90000",
        IMESSAGE_RELAY_POLL_MS: "3000",
        IMESSAGE_RELAY_DOCTOR_TIMEOUT_MS: "12000",
        IMESSAGE_OSASCRIPT_BIN: "/usr/bin/osascript",
      },
      platform: "darwin",
      host: "Gagans-MacBook-Pro",
    });

    expect(config).toMatchObject({
      baseUrl: "https://api.ipop.ai",
      relayId: "gagan-mac",
      version: "v1",
      limit: 7,
      leaseMs: 90_000,
      pollMs: 3_000,
      doctorTimeoutMs: 12_000,
      once: true,
      doctor: true,
      osascriptBin: "/usr/bin/osascript",
    });
    expect(config.secret).toBe("SECRET_RELAY");
  });

  it("doctor proves osascript and signed heartbeat without claiming or sending jobs", async () => {
    const execFileImpl = vi.fn(async (_bin, args) => ({
      stdout: args.includes("return \"ok\"") ? "ok" : "2\n",
      stderr: "",
    }));
    const postJsonImpl = vi.fn(async () => ({ relayHeartbeat: { active: true } }));
    const checks = await runRelayDoctor({
      config: parseRelayWorkerConfig({
        argv: ["--doctor"],
        env: { IMESSAGE_RELAY_WEBHOOK_SECRET: "secret" },
        platform: "darwin",
        host: "Gagans-MacBook-Pro",
      }),
      execFileImpl,
      postJsonImpl,
    });

    expect(checks).toEqual([
      { name: "osascript", status: "pass", message: "osascript is runnable" },
      {
        name: "messages-access",
        status: "pass",
        message: "Messages AppleScript access is available (2 service(s) visible)",
      },
      {
        name: "api-heartbeat",
        status: "pass",
        message: "signed heartbeat accepted by https://api.ipop.ai",
      },
    ]);
    expect(JSON.stringify(checks)).not.toContain("secret");
    expect(execFileImpl).toHaveBeenCalledWith(
      "osascript",
      ["-e", "return \"ok\""],
      expect.objectContaining({ timeout: 10_000, killSignal: "SIGTERM" }),
    );
    expect(execFileImpl).toHaveBeenCalledWith("osascript", [
      "-e",
      "tell application \"Messages\" to count services",
    ], expect.objectContaining({ timeout: 10_000, killSignal: "SIGTERM" }));
    expect(postJsonImpl).toHaveBeenCalledWith(
      "https://api.ipop.ai/imessage/relay/heartbeat",
      "secret",
      { relayId: "mac-Gagans-MacBook-Pro", host: "Gagans-MacBook-Pro", version: null },
    );
  });

  it("doctor reports missing Messages AppleScript access without hiding a valid API heartbeat", async () => {
    const checks = await runRelayDoctor({
      config: parseRelayWorkerConfig({
        argv: ["--doctor"],
        env: { IMESSAGE_RELAY_WEBHOOK_SECRET: "secret" },
        platform: "darwin",
        host: "Gagans-MacBook-Pro",
      }),
      execFileImpl: vi.fn(async (_bin, args) => {
        if (args.includes("return \"ok\"")) return { stdout: "ok", stderr: "" };
        throw new Error("Not authorized to send Apple events to Messages");
      }),
      postJsonImpl: vi.fn(async () => ({ relayHeartbeat: { active: true } })),
    });

    expect(checks).toEqual(
      expect.arrayContaining([
        { name: "osascript", status: "pass", message: "osascript is runnable" },
        {
          name: "messages-access",
          status: "fail",
          message: "Not authorized to send Apple events to Messages",
        },
        {
          name: "api-heartbeat",
          status: "pass",
          message: "signed heartbeat accepted by https://api.ipop.ai",
        },
      ]),
    );
  });

  it("doctor bounds a hanging Messages AppleScript probe and still reports API heartbeat", async () => {
    const checks = await runRelayDoctor({
      config: parseRelayWorkerConfig({
        argv: ["--doctor"],
        env: {
          IMESSAGE_RELAY_WEBHOOK_SECRET: "secret",
          IMESSAGE_RELAY_DOCTOR_TIMEOUT_MS: "25",
        },
        platform: "darwin",
        host: "Gagans-MacBook-Pro",
      }),
      execFileImpl: vi.fn(async (_bin, args) => {
        if (args.includes("return \"ok\"")) return { stdout: "ok", stderr: "" };
        const error = new Error("Command failed: osascript");
        Object.assign(error, { killed: true, signal: "SIGTERM" });
        throw error;
      }),
      postJsonImpl: vi.fn(async () => ({ relayHeartbeat: { active: true } })),
    });

    expect(checks).toEqual(
      expect.arrayContaining([
        { name: "osascript", status: "pass", message: "osascript is runnable" },
        {
          name: "messages-access",
          status: "fail",
          message: "Messages AppleScript access timed out after 25ms",
        },
        {
          name: "api-heartbeat",
          status: "pass",
          message: "signed heartbeat accepted by https://api.ipop.ai",
        },
      ]),
    );
  });

  it("doctor returns a failing check when the API rejects the relay secret", async () => {
    const checks = await runRelayDoctor({
      config: parseRelayWorkerConfig({
        argv: ["--doctor"],
        env: { IMESSAGE_RELAY_WEBHOOK_SECRET: "wrong" },
        platform: "darwin",
        host: "Gagans-MacBook-Pro",
      }),
      execFileImpl: vi.fn(async () => ({ stdout: "ok", stderr: "" })),
      postJsonImpl: vi.fn(async () => {
        throw new Error("unauthorized");
      }),
    });

    expect(checks).toContainEqual({ name: "api-heartbeat", status: "fail", message: "unauthorized" });
  });
});
