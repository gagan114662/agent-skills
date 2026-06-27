import { describe, expect, it, vi } from "vitest";
import {
  IMessageRelayService,
  imessageRoomPreflight,
  imessageRoomReceipt,
} from "../../src/imessage/service.js";

const base = {
  enabled: true,
  recipient: "gagan@example.com",
  dryRun: false,
  maxChars: 120,
};

describe("IMessageRelayService", () => {
  it("formats room receipts with channel/message correlation", () => {
    expect(
      imessageRoomReceipt({
        workspaceId: "ws1",
        channelId: "ch1",
        messageId: "msg1",
        author: "Gagan",
        text: "launch the room",
      }),
    ).toBe(
      [
        "ipop iMessage room",
        "author: Gagan",
        "channel: ch1",
        "message: msg1",
        "receipt: imessage:ch1:msg1",
        "",
        "launch the room",
      ].join("\n"),
    );
  });

  it("is disabled by default unless the relay is explicitly enabled", async () => {
    const send = vi.fn();
    const service = new IMessageRelayService({ ...base, enabled: false }, { send });

    await expect(service.send({ text: "hello" })).resolves.toMatchObject({ status: "disabled" });
    expect(send).not.toHaveBeenCalled();
  });

  it("requires a configured recipient", async () => {
    const service = new IMessageRelayService({ ...base, recipient: undefined }, { send: vi.fn() });

    await expect(service.send({ text: "hello" })).resolves.toMatchObject({ status: "not_configured" });
  });

  it("blocks messages over the configured length guardrail", async () => {
    const service = new IMessageRelayService({ ...base, maxChars: 4 }, { send: vi.fn() });

    await expect(service.send({ text: "hello" })).resolves.toMatchObject({ status: "too_long" });
  });

  it("dry-runs without calling Apple Messages", async () => {
    const send = vi.fn();
    const service = new IMessageRelayService({ ...base, dryRun: true }, { send });

    await expect(service.send({ text: "hello" })).resolves.toMatchObject({ status: "dry_run" });
    expect(send).not.toHaveBeenCalled();
  });

  it("blocks room startup before persistence when the relay is not live (#1283)", () => {
    expect(
      imessageRoomPreflight({
        enabled: false,
        configured: true,
        dryRun: false,
        recipient: "gagan@example.com",
        maxChars: 120,
      }),
    ).toMatchObject({ status: "disabled" });
    expect(
      imessageRoomPreflight({
        enabled: true,
        configured: false,
        dryRun: false,
        maxChars: 120,
      }),
    ).toMatchObject({ status: "not_configured" });
    expect(
      imessageRoomPreflight({
        enabled: true,
        configured: true,
        dryRun: true,
        recipient: "gagan@example.com",
        maxChars: 120,
      }),
    ).toMatchObject({
      status: "dry_run",
      error: "iMessage relay is still in dry-run mode; no real Messages room was started.",
    });
    expect(
      imessageRoomPreflight({
        enabled: true,
        configured: true,
        dryRun: false,
        recipient: "gagan@example.com",
        maxChars: 120,
      }),
    ).toBeNull();
  });

  it("sends through the adapter when enabled and configured", async () => {
    const send = vi.fn(async () => undefined);
    const service = new IMessageRelayService({ ...base, serviceName: "E:test" }, { send });

    await expect(service.send({ text: "hello" })).resolves.toMatchObject({ status: "sent" });
    expect(send).toHaveBeenCalledWith({
      recipient: "gagan@example.com",
      text: "hello",
      serviceName: "E:test",
    });
  });

  it("records adapter errors as failed results", async () => {
    const service = new IMessageRelayService(
      base,
      { send: vi.fn(async () => { throw new Error("Messages denied automation"); }) },
    );

    await expect(service.send({ text: "hello" })).resolves.toMatchObject({
      status: "failed",
      error: "Messages denied automation",
    });
  });
});
