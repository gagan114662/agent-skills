import { describe, expect, it } from "vitest";
import { buildLaunchPlaybook } from "../../src/workflows/launch-playbook.js";

describe("launch-day playbook builder (#600)", () => {
  it("builds a timed assigned checklist with approval-gated launch posts and live monitoring", () => {
    const launchAt = new Date("2026-07-01T16:00:00.000Z");

    const playbook = buildLaunchPlaybook({
      name: "ipop Product Hunt launch",
      launchAt,
      channelId: "chan-launch",
      channels: ["product_hunt", "hacker_news", "communities"],
      ownerMessage: "Owner is launch commander.",
    });

    expect(playbook.workflow.name).toBe("Launch-day coordination: ipop Product Hunt launch");
    expect(playbook.workflow.actions.length).toBeLessThanOrEqual(10);
    expect(playbook.checklist.map((item) => item.phase)).toEqual([
      "pre_launch",
      "pre_launch",
      "launch",
      "launch",
      "launch",
      "monitoring",
      "monitoring",
      "monitoring",
    ]);
    expect(playbook.checklist[0]).toMatchObject({
      owner: "quill",
      title: "Prepare launch assets",
      dueAt: "2026-06-29T16:00:00.000Z",
    });
    expect(playbook.checklist.some((item) => item.owner === "lens" && item.title.includes("Monitor"))).toBe(true);
    expect(playbook.workflow.actions.filter((action) => action.kind === "draft_send")).toHaveLength(3);
    expect(playbook.workflow.actions.filter((action) => action.kind === "agent_task")).toHaveLength(4);
    expect(playbook.workflow.actions.some((action) => action.kind === "notify_owner")).toBe(true);
    expect(playbook.workflow.actions.every((action) => action.kind !== "draft_send" || action.sendKind === "social.post")).toBe(true);
  });
});
