import { describe, it, expect } from "vitest";
import { buildConnectPrompt } from "../../../src/marketing/connect-prompt.js";

describe("buildConnectPrompt (#68 — friendly brand-voice connect message)", () => {
  it("addresses the owner in the persona's voice and names the persona", () => {
    const msg = buildConnectPrompt("scout");
    expect(msg).toContain("scout");
  });

  it("tells the owner exactly how to connect (Settings → Connect Claude)", () => {
    const msg = buildConnectPrompt("quill");
    expect(msg).toMatch(/connect/i);
    expect(msg).toMatch(/claude/i);
    expect(msg).toMatch(/settings/i);
  });

  it("is friendly, not an error dump (no stack/exception words)", () => {
    const msg = buildConnectPrompt("echo");
    expect(msg).not.toMatch(/error|exception|crash|failed/i);
    expect(msg.length).toBeGreaterThan(20);
  });
});
