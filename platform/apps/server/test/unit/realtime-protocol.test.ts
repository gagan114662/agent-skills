import { describe, it, expect } from "vitest";
import { parseClientCommand } from "../../src/realtime/protocol.js";

describe("parseClientCommand", () => {
  it("parses a subscribe command", () => {
    expect(parseClientCommand('{"type":"subscribe","channelId":"c1"}')).toEqual({
      type: "subscribe",
      channelId: "c1",
    });
  });

  it("parses an unsubscribe command", () => {
    expect(parseClientCommand('{"type":"unsubscribe","channelId":"c1"}')).toEqual({
      type: "unsubscribe",
      channelId: "c1",
    });
  });

  it("parses presence and ping", () => {
    expect(parseClientCommand('{"type":"presence","status":"away"}')).toEqual({
      type: "presence",
      status: "away",
    });
    expect(parseClientCommand('{"type":"ping"}')).toEqual({ type: "ping" });
  });

  it("parses watch / unwatch for a shared cloud workspace (#55)", () => {
    expect(parseClientCommand('{"type":"watch","cloudWorkspaceId":"cw1"}')).toEqual({
      type: "watch",
      cloudWorkspaceId: "cw1",
    });
    expect(parseClientCommand('{"type":"unwatch","cloudWorkspaceId":"cw1"}')).toEqual({
      type: "unwatch",
      cloudWorkspaceId: "cw1",
    });
    expect(parseClientCommand('{"type":"watch"}')).toBeNull(); // missing id
    expect(parseClientCommand('{"type":"watch","cloudWorkspaceId":""}')).toBeNull(); // empty id
  });

  it("rejects malformed JSON without throwing", () => {
    expect(parseClientCommand("not json")).toBeNull();
    expect(parseClientCommand("")).toBeNull();
    expect(parseClientCommand("[1,2,3]")).toBeNull();
    expect(parseClientCommand("null")).toBeNull();
  });

  it("rejects unknown or incomplete commands", () => {
    expect(parseClientCommand('{"type":"subscribe"}')).toBeNull(); // missing channelId
    expect(parseClientCommand('{"type":"subscribe","channelId":""}')).toBeNull(); // empty channelId
    expect(parseClientCommand('{"type":"presence","status":"offline"}')).toBeNull(); // not client-settable
    expect(parseClientCommand('{"type":"bogus"}')).toBeNull();
  });
});
