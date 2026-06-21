import { describe, it, expect } from "vitest";
import {
  classifyExecutionBoundary,
  isGatedAction,
} from "../../src/agent-tools/decide.js";
import { findExecutionTool } from "../../src/agent-tools/registry.js";

const publish = findExecutionTool("content.publish")!;
const post = findExecutionTool("social.post")!;
const ads = findExecutionTool("ads.launch_campaign")!;

describe("agent-tools/decide — isGatedAction (permission: no orphan authority)", () => {
  it("accepts a known #13 gated action and rejects an unknown one", () => {
    expect(isGatedAction("hosted.publish")).toBe(true);
    expect(isGatedAction("social.publish_post")).toBe(true);
    expect(isGatedAction("venture.ad_spend")).toBe(true);
    expect(isGatedAction("chat.post_message")).toBe(false); // not an outward execution action
    expect(isGatedAction("definitely.not.real")).toBe(false);
  });
});

describe("agent-tools/decide — classifyExecutionBoundary (always human-gated)", () => {
  it("a publicly-visible publish is a public boundary and ALWAYS gates", () => {
    const d = classifyExecutionBoundary(publish, null);
    expect(d.boundary).toBe("public");
    expect(d.gate).toBe(true);
    expect(d.reason.toLowerCase()).toContain("public");
  });

  it("an outbound post is an outbound boundary and ALWAYS gates", () => {
    const d = classifyExecutionBoundary(post, null);
    expect(d.boundary).toBe("outbound");
    expect(d.gate).toBe(true);
  });

  it("a budgeted ad launch is a money boundary, gates, and names the amount", () => {
    const d = classifyExecutionBoundary(ads, 500);
    expect(d.boundary).toBe("money");
    expect(d.gate).toBe(true);
    expect(d.reason).toContain("500");
  });

  it("there is NO un-gated outcome — every execution boundary pauses for a human", () => {
    for (const tool of [publish, post, ads]) {
      expect(classifyExecutionBoundary(tool, 0).gate).toBe(true);
      expect(classifyExecutionBoundary(tool, 1000).gate).toBe(true);
    }
  });
});
