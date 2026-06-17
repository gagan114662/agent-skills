import { describe, it, expect } from "vitest";
import { buildDefaultRegistry } from "../../src/approvals/runtime.js";
import { validateHostedPublish } from "../../src/approvals/executor.js";
import { evaluatePolicy, isMoneyAction, HOSTED_PUBLISH_ACTION } from "../../src/approvals/policy.js";
import type { HostedPublishDispatcher } from "../../src/hosted/dispatcher.js";

/**
 * #266 — the `hosted.publish` executor: the OWNER's #13 approval is the publish trigger. Without a
 * dispatcher it is a pure acknowledgement (no side effect); with one it ships. It is NOT a money action,
 * but the hosted SERVICE always parks an approval (the hard constraint), so a page never publishes without
 * the owner approving in the #13 queue.
 */
describe("hosted.publish executor (#266)", () => {
  it("validates the payload (pageId required; slug optional)", () => {
    expect(validateHostedPublish({ pageId: "p1" }).ok).toBe(true);
    expect(validateHostedPublish({ pageId: "p1", slug: "x" }).ok).toBe(true);
    expect(validateHostedPublish({ slug: "x" }).ok).toBe(false);
    expect(validateHostedPublish({ pageId: "p1", slug: 7 }).ok).toBe(false);
    expect(validateHostedPublish(null).ok).toBe(false);
  });

  it("is not a money action (gating is structural via the always-park service, not the money predicate)", () => {
    expect(isMoneyAction(HOSTED_PUBLISH_ACTION)).toBe(false);
  });

  it("is registered and acknowledges (no side effect) when no dispatcher is wired", async () => {
    const exec = buildDefaultRegistry().get("hosted.publish")!;
    expect(exec).toBeDefined();
    const result = await exec.execute(
      { pageId: "page-1", slug: "launch" },
      { workspaceId: "ws1", requesterMemberId: "m1" } as never,
    );
    expect(result).toMatchObject({ acknowledged: true, pageId: "page-1" });
    expect(result.url).toBeUndefined(); // nothing shipped
  });

  it("ships through the dispatcher on approval, tying the live URL to THIS approval id", async () => {
    const seen: { workspaceId: string; approvalRequestId: string; pageId: string }[] = [];
    const dispatcher: HostedPublishDispatcher = {
      async ship(payload, ctx) {
        seen.push({ ...ctx, pageId: String(payload.pageId) });
        if (!ctx.approvalRequestId) return null;
        return { pageId: String(payload.pageId), url: "https://acme.sites.ipop.app/launch", live: true };
      },
    };
    const exec = buildDefaultRegistry(undefined, undefined, undefined, undefined, dispatcher).get(
      "hosted.publish",
    )!;
    const result = await exec.execute(
      { pageId: "page-1", slug: "launch" },
      { workspaceId: "ws1", requesterMemberId: "m1", requestId: "appr-42" } as never,
    );
    expect(result).toMatchObject({ acknowledged: true, live: true, url: "https://acme.sites.ipop.app/launch" });
    expect(seen[0]).toEqual({ workspaceId: "ws1", approvalRequestId: "appr-42", pageId: "page-1" });
  });

  it("a non-money hosted.publish has no auto-gate rule — the service is what guarantees the park", () => {
    expect(evaluatePolicy({ actionType: HOSTED_PUBLISH_ACTION }, []).requiresApproval).toBe(false);
  });
});
