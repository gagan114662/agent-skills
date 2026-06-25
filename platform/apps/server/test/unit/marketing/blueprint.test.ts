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
  foundingVentureFor,
  FOUNDING_VENTURE,
  DOGFOOD_VENTURE,
} from "../../../src/marketing/blueprint.js";
import { validatePersonaInput } from "../../../src/subagents/scope.js";

/**
 * #123 blueprint — the pure source of truth for the marketing department fleet. These assertions pin
 * the agency's shape (channels, named agents, which functions send externally) and the house voice, so
 * the seeder/roster/trigger can rely on it and so extending it is a deliberate, tested change.
 */
describe("#123 marketing blueprint", () => {
  it("defines exactly the eight department agents with the named handles", () => {
    const handles = MARKETING_DEPARTMENTS.map((d) => d.agent.handle).sort();
    expect(handles).toEqual(["bid", "comet", "echo", "lens", "mark", "postmark", "quill", "scout"]);
    const channels = MARKETING_DEPARTMENTS.map((d) => d.channel).sort();
    expect(channels).toEqual(["ads", "analytics", "brand", "content", "email", "reach", "seo", "social"]);
  });

  it("seeds ten channels: every department channel plus #general and #launch, all unique", () => {
    expect(SHARED_CHANNELS).toEqual(["general", "launch"]);
    expect(MARKETING_CHANNELS).toHaveLength(10);
    expect(new Set(MARKETING_CHANNELS).size).toBe(10);
    for (const c of ["seo", "social", "content", "email", "ads", "analytics", "brand", "reach", "general", "launch"]) {
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

  it("gives every ipop agent the canonical prompt structure without exposing private reasoning (#1164)", () => {
    const sections = [
      "1. Task context",
      "2. Tone context",
      "3. Background data, documents, and images",
      "4. Detailed task description & rules",
      "5. Examples",
      "6. Conversation history",
      "7. Immediate task description or request",
      "8. Thinking step by step / take a deep breath",
      "9. Output formatting",
      "10. Prefilled response (if any)",
    ];

    for (const spec of marketingAgentSpecs()) {
      let previousIndex = -1;
      for (const section of sections) {
        const nextIndex = spec.systemPrompt.indexOf(section);
        expect(nextIndex, `${spec.handle} prompt includes ${section}`).toBeGreaterThan(previousIndex);
        previousIndex = nextIndex;
      }
      expect(spec.systemPrompt).toContain("If a section is missing or unavailable");
      expect(spec.systemPrompt).toContain("do not reveal private chain-of-thought");
      expect(spec.systemPrompt).toContain("never overrides approval gates");
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

  // #235: ipop runs ITS OWN marketing as venture #1 in the owner's own workspace.
  it("points the owner's own workspace at the ipop dogfood venture, everyone else at the neutral stub", () => {
    // Owner workspace → the concrete ipop marketing brief with the real pricing tiers.
    const owned = foundingVentureFor("ws-owner", "ws-owner");
    expect(owned).toBe(DOGFOOD_VENTURE);
    expect(owned.wedge).toContain("ipop.ai");
    expect(owned.wedge).toMatch(/\$49/);
    expect(owned.wedge).toMatch(/\$199/);
    expect(owned.wedge).toMatch(/\$499/);
    // A customer workspace (no owner marker, or a different one) keeps the brand-neutral founding stub —
    // it never inherits ipop's growth brief.
    expect(foundingVentureFor("ws-customer", undefined)).toBe(FOUNDING_VENTURE);
    expect(foundingVentureFor("ws-customer", "ws-owner")).toBe(FOUNDING_VENTURE);
    // The dogfood venture is a real IdeaInput (the #96 loop refines it from here).
    for (const k of ["problem", "targetUser", "insight", "wedge", "marketPath"] as const) {
      expect(DOGFOOD_VENTURE[k].length).toBeGreaterThan(0);
    }
  });
});
