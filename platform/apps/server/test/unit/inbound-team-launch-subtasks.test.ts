import { describe, it, expect } from "vitest";
import {
  buildSubtask,
  LAUNCH_HANDLES,
  MESSAGING_SUBTASK_TIMEOUT_MS,
  MESSAGING_SUBTASK_MAX_ATTEMPTS,
} from "../../src/messaging/inbound-team-launch.js";
import { DEFAULT_RUNTIME_PROVIDER } from "../../src/runtime/provider.js";

/**
 * #1536: a brief sent from a messaging room (Telegram/iMessage/WhatsApp) builds the same
 * Scout -> Quill -> Lens -> Echo/Bid graph the web room does. Every stage must carry a bounded
 * wall clock and attempt count so a hung agent fails loudly instead of leaving the run stuck on
 * "working" forever (the inbound path previously set neither).
 */
describe("inbound messaging team-run subtasks (#1536)", () => {
  it("bounds every stage with a wall-clock timeout and attempt cap", () => {
    for (const handle of LAUNCH_HANDLES) {
      const subtask = buildSubtask(handle, `mem_${handle}`, "grow acme.test", DEFAULT_RUNTIME_PROVIDER);
      expect(subtask.timeoutMs).toBe(MESSAGING_SUBTASK_TIMEOUT_MS);
      expect(subtask.timeoutMs).toBeGreaterThan(0);
      expect(Number.isFinite(subtask.timeoutMs)).toBe(true);
      expect(subtask.maxAttempts).toBe(MESSAGING_SUBTASK_MAX_ATTEMPTS);
      expect(subtask.maxAttempts).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps the Scout -> Quill research handoff wiring intact", () => {
    const scout = buildSubtask("scout", "mem_scout", "grow acme.test", DEFAULT_RUNTIME_PROVIDER);
    const quill = buildSubtask("quill", "mem_quill", "grow acme.test", DEFAULT_RUNTIME_PROVIDER);

    expect(scout.phase).toBe(1);
    expect(scout.producesArtifacts).toEqual(["scout_research", "brand_voice"]);

    expect(quill.phase).toBe(2);
    expect(quill.requiresArtifacts).toEqual(["scout_research", "brand_voice"]);
    expect(quill.producesArtifacts).toEqual(["draft_set"]);
  });
});
