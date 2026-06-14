import { describe, it, expect } from "vitest";
import { buildContentPublish, CONTENT_PUBLISH_KIND } from "../../../src/site/publish.js";
import { evaluatePolicy } from "../../../src/approvals/policy.js";
import { validateExternalSend } from "../../../src/approvals/executor.js";

/**
 * #153 publish — publishing a marketing page is an `external.send` action. Under #243 (money-only
 * approval) content publishing is AUTONOMOUS: it carries no money, so the fleet ships it on its own with
 * no owner prompt. This module only builds the descriptor; the policy engine decides the gate.
 */
describe("#153 content publish ships autonomously (#243)", () => {
  it("builds an external.send descriptor targeting the public path", () => {
    const action = buildContentPublish({
      section: "compare",
      slug: "vs-diy",
      title: "ipop vs. doing it yourself",
      agent: "quill",
    });
    expect(action.actionType).toBe("external.send");
    expect(action.payload.kind).toBe(CONTENT_PUBLISH_KIND);
    expect(action.payload.target).toBe("/compare/vs-diy");
    expect(action.payload.summary).toContain("quill");
  });

  it("maps stories/guides sections to their plural URL prefixes", () => {
    expect(buildContentPublish({ section: "stories", slug: "ipop-marketing", title: "T", agent: "quill" }).payload.target).toBe(
      "/stories/ipop-marketing",
    );
    expect(buildContentPublish({ section: "guides", slug: "seo", title: "T", agent: "scout" }).payload.target).toBe(
      "/guides/seo",
    );
  });

  it("ships autonomously by default with no workspace rule (no money → no owner prompt) (#243)", () => {
    const action = buildContentPublish({ section: "guides", slug: "seo", title: "SEO", agent: "scout" });
    expect(action.amount).toBeNull();
    expect(evaluatePolicy({ actionType: action.actionType, amount: action.amount }, []).requiresApproval).toBe(false);
  });

  it("produces a payload the existing external.send validator accepts (no executor change)", () => {
    const action = buildContentPublish({ section: "changelog", slug: "2026-06-08", title: "Week", agent: "echo" });
    expect(validateExternalSend(action.payload).ok).toBe(true);
  });
});
