import { describe, expect, it, vi } from "vitest";
import { MacOsMessagesAdapter } from "../../src/imessage/macos-adapter.js";
import {
  buildInboundRelayDeliveries,
  parseRelayWorkerConfig,
  rememberSentRelayJob,
  runRelayDoctor,
} from "../../src/imessage/relay-worker-cli.js";

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
        IMESSAGE_SQLITE_BIN: "/usr/bin/sqlite3",
        IMESSAGE_MESSAGES_DB_PATH: "/tmp/messages/chat.db",
        IMESSAGE_RELAY_STATE_FILE: "/tmp/ipop/imessage-state.json",
        IMESSAGE_RELAY_INBOUND_LIMIT: "13",
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
      sqliteBin: "/usr/bin/sqlite3",
      inboundEnabled: true,
      messagesDbPath: "/tmp/messages/chat.db",
      stateFile: "/tmp/ipop/imessage-state.json",
      inboundLimit: 13,
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
        env: { IMESSAGE_RELAY_WEBHOOK_SECRET: "secret", IMESSAGE_RELAY_INBOUND_ENABLED: "0" },
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
      { relayId: "mac-Gagans-MacBook-Pro", host: "Gagans-MacBook-Pro", version: null, messagesAccess: "ok" },
    );
  });

  it("doctor reports missing Messages AppleScript access without hiding a valid API heartbeat", async () => {
    const postJsonImpl = vi.fn(async () => ({ relayHeartbeat: { active: true } }));
    const checks = await runRelayDoctor({
      config: parseRelayWorkerConfig({
        argv: ["--doctor"],
        env: { IMESSAGE_RELAY_WEBHOOK_SECRET: "secret", IMESSAGE_RELAY_INBOUND_ENABLED: "0" },
        platform: "darwin",
        host: "Gagans-MacBook-Pro",
      }),
      execFileImpl: vi.fn(async (_bin, args) => {
        if (args.includes("return \"ok\"")) return { stdout: "ok", stderr: "" };
        throw new Error("Not authorized to send Apple events to Messages");
      }),
      postJsonImpl,
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
    expect(postJsonImpl).toHaveBeenCalledWith(
      "https://api.ipop.ai/imessage/relay/heartbeat",
      "secret",
      { relayId: "mac-Gagans-MacBook-Pro", host: "Gagans-MacBook-Pro", version: null, messagesAccess: "failed" },
    );
  });

  it("doctor bounds a hanging Messages AppleScript probe and still reports API heartbeat", async () => {
    const postJsonImpl = vi.fn(async () => ({ relayHeartbeat: { active: true } }));
    const checks = await runRelayDoctor({
      config: parseRelayWorkerConfig({
        argv: ["--doctor"],
        env: {
          IMESSAGE_RELAY_WEBHOOK_SECRET: "secret",
          IMESSAGE_RELAY_INBOUND_ENABLED: "0",
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
      postJsonImpl,
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
    expect(postJsonImpl).toHaveBeenCalledWith(
      "https://api.ipop.ai/imessage/relay/heartbeat",
      "secret",
      { relayId: "mac-Gagans-MacBook-Pro", host: "Gagans-MacBook-Pro", version: null, messagesAccess: "failed" },
    );
  });

  it("doctor returns a failing check when the API rejects the relay secret", async () => {
    const checks = await runRelayDoctor({
      config: parseRelayWorkerConfig({
        argv: ["--doctor"],
        env: { IMESSAGE_RELAY_WEBHOOK_SECRET: "wrong", IMESSAGE_RELAY_INBOUND_ENABLED: "0" },
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

  it("doctor reports missing Messages chat database access when inbound sync is enabled", async () => {
    const adapter = {
      latestMessageRowId: vi.fn(async () => 123),
    } as unknown as MacOsMessagesAdapter;
    const checks = await runRelayDoctor({
      config: parseRelayWorkerConfig({
        argv: ["--doctor"],
        env: {
          IMESSAGE_RELAY_WEBHOOK_SECRET: "secret",
          IMESSAGE_MESSAGES_DB_PATH: "/tmp/messages-chat.db",
        },
        platform: "darwin",
        host: "Gagans-MacBook-Pro",
      }),
      execFileImpl: vi.fn(async () => ({ stdout: "ok", stderr: "" })),
      postJsonImpl: vi.fn(async () => ({ relayHeartbeat: { active: true } })),
      adapter,
    });

    expect(checks).toContainEqual({
      name: "messages-db",
      status: "fail",
      message: "Messages chat database not found at /tmp/messages-chat.db",
    });
    expect(adapter.latestMessageRowId).not.toHaveBeenCalled();
  });

  it("maps new inbound Messages rows onto the latest sent room receipt", () => {
    const state = rememberSentRelayJob(
      { trackedReceipts: {} },
      {
        id: "job_1",
        workspaceId: "workspace_1",
        channelId: "channel_1",
        messageId: "message_1",
        purpose: "room",
        recipient: "Founder@Example.com",
        serviceName: null,
        text: "receipt: imessage:channel_1:message_1",
        receipt: "imessage:channel_1:message_1",
      },
      40,
      new Date("2026-06-29T00:00:00Z"),
    );

    const result = buildInboundRelayDeliveries(state, [
      { rowId: 39, sender: "founder@example.com", text: "old reply" },
      { rowId: 41, sender: "founder@example.com", text: "tell Scout to update pricing" },
      { rowId: 42, sender: "other@example.com", text: "ignore me" },
    ]);

    expect(result.deliveries).toEqual([
      {
        rowId: 41,
        payload: {
          workspaceId: "workspace_1",
          receipt: "imessage:channel_1:message_1",
          sender: "founder@example.com",
          text: "tell Scout to update pricing",
        },
      },
    ]);
    expect(result.state.trackedReceipts["founder@example.com"]?.lastSeenRowId).toBe(41);
  });
});
