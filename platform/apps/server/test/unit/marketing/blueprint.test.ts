import { describe, it, expect } from "vitest";
import {
  MARKETING_DEPARTMENTS,
  MARKETING_CHANNELS,
  SHARED_CHANNELS,
  BRAND_VOICE,
  EXTERNAL_SEND_DEPARTMENTS,
  marketingAgentSpecs,
  departmentForChannel,
  departmentForHandle,
  isExternalSendDepartment,
} from "../../../src/marketing/blueprint.js";
import { validatePersonaInput } from "../../../src/subagents/scope.js";

/**
 * #123 blueprint — the pure source of truth for the marketing department fleet. These assertions pin
 * the agency's shape (channels, named agents, which functions send externally) and the house voice, so
 * the seeder/roster/trigger can rely on it and so extending it is a deliberate, tested change.
 */
describe("#123 marketing blueprint", () => {
  it("defines exactly the seven department agents with the named handles", () => {
    const handles = MARKETING_DEPARTMENTS.map((d) => d.agent.handle).sort();
    expect(handles).toEqual(["bid", "echo", "lens", "mark", "postmark", "quill", "scout"]);
    const channels = MARKETING_DEPARTMENTS.map((d) => d.channel).sort();
    expect(channels).toEqual(["ads", "analytics", "brand", "content", "email", "seo", "social"]);
  });

  it("seeds nine channels: every department channel plus #general and #launch, all unique", () => {
    expect(SHARED_CHANNELS).toEqual(["general", "launch"]);
    expect(MARKETING_CHANNELS).toHaveLength(9);
    expect(new Set(MARKETING_CHANNELS).size).toBe(9);
    for (const c of ["seo", "social", "content", "email", "ads", "analytics", "brand", "general", "launch"]) {
      expect(MARKETING_CHANNELS).toContain(c);
    }
  });

  it("maps a channel to its department and a handle back to its department", () => {
    expect(departmentForChannel("seo")?.agent.handle).toBe("scout");
    expect(departmentForChannel("social")?.agent.handle).toBe("echo");
    expect(departmentForChannel("general")).toBeUndefined(); // shared, no dedicated agent
    expect(departmentForHandle("scout")?.channel).toBe("seo");
    expect(departmentForHandle("nobody")).toBeUndefined();
  });

  it("marks only social, email and ads as external-send departments (the rest stay internal)", () => {
    expect([...EXTERNAL_SEND_DEPARTMENTS].sort()).toEqual(["ads", "email", "social"]);
    expect(isExternalSendDepartment("social")).toBe(true);
    expect(isExternalSendDepartment("email")).toBe(true);
    expect(isExternalSendDepartment("ads")).toBe(true);
    expect(isExternalSendDepartment("seo")).toBe(false);
    expect(isExternalSendDepartment("brand")).toBe(false);
  });

  it("gives every agent a draft-only tool ceiling with NO send/post/email capability", () => {
    for (const spec of marketingAgentSpecs()) {
      expect(spec.allowedTools.length).toBeGreaterThan(0);
      const tools = spec.allowedTools.map((t) => t.toLowerCase());
      // Leaving the building must only be possible through the #13 gate, never a harness tool.
      for (const banned of ["send", "post", "email", "tweet", "publish", "spend"]) {
        expect(tools.some((t) => t.includes(banned))).toBe(false);
      }
    }
  });

  it("every agent spec is a valid persona definition (so seeding never throws on it)", () => {
    for (const spec of marketingAgentSpecs()) {
      const v = validatePersonaInput({
        name: spec.handle,
        systemPrompt: spec.systemPrompt,
        allowedTools: [...spec.allowedTools],
        model: spec.model,
      });
      expect(v.name).toBe(spec.handle);
      expect(spec.intro.length).toBeGreaterThan(0);
    }
    for (const d of MARKETING_DEPARTMENTS) {
      expect(d.welcomeTask.length).toBeGreaterThan(0);
    }
  });

  it("carries the house voice (warm, plural, signed off by the robots)", () => {
    expect(BRAND_VOICE.signOff.toLowerCase()).toContain("made by robots");
    expect(BRAND_VOICE.welcome.toLowerCase()).toContain("marketing department");
    expect(BRAND_VOICE.emptyState.length).toBeGreaterThan(0);
  });
});
