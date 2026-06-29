import { describe, expect, it } from "vitest";
import { externalRoomSourceForIdentity } from "../../src/messaging/delivery.js";

describe("messaging delivery external-room source (#1267)", () => {
  it("marks agent-authored room posts and replies as agent posts for external messaging rooms", () => {
    expect(externalRoomSourceForIdentity({ kind: "agent" }, "room_message")).toBe("agent_post");
    expect(externalRoomSourceForIdentity({ kind: "agent" }, "thread_reply")).toBe("agent_post");
  });

  it("preserves human room semantics", () => {
    expect(externalRoomSourceForIdentity({ kind: "human" }, "room_message")).toBe("room_message");
    expect(externalRoomSourceForIdentity({ kind: "human" }, "thread_reply")).toBe("thread_reply");
  });
});
