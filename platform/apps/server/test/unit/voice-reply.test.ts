import { describe, it, expect } from "vitest";
import { buildVoiceReply, VOICE_REPLY_KIND } from "../../src/voice/reply.js";

describe("voice/reply — buildVoiceReply (#114): outbound replies ride the #13 external.send gate", () => {
  it("builds an external.send descriptor that is sensitive-by-default (no money)", () => {
    const d = buildVoiceReply({ summary: "Thanks for reaching out — here is a fix", target: "user@example.com" });
    expect(d.actionType).toBe("external.send");
    expect(d.amount).toBeNull(); // a reply moves no money; external.send is sensitive-by-default
    expect(d.payload.kind).toBe(VOICE_REPLY_KIND);
    expect(d.payload.summary).toContain("Thanks for reaching out");
    expect(d.payload.target).toBe("user@example.com");
  });

  it("omits target when not provided", () => {
    const d = buildVoiceReply({ summary: "ack" });
    expect(d.payload.target).toBeUndefined();
  });
});
