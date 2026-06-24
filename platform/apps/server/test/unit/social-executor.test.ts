import { describe, expect, it } from "vitest";
import { buildDefaultRegistry } from "../../src/approvals/runtime.js";
import { SOCIAL_PUBLISH_POST_ACTION } from "../../src/approvals/policy.js";
import type { SocialPublishDispatcher } from "../../src/social/dispatcher.js";

describe("social.publish_post executor (#924)", () => {
  const payload = { source: "social", postId: "post-1", networks: ["x"] };
  const ctx = { workspaceId: "ws1", requesterMemberId: "m1", requestId: "appr-1" } as never;

  it("is registered and acknowledges when no dispatcher is wired", async () => {
    const exec = buildDefaultRegistry().get(SOCIAL_PUBLISH_POST_ACTION)!;
    expect(exec).toBeDefined();
    const result = await exec.execute(payload, ctx);
    expect(result).toEqual({ acknowledged: true, postId: "post-1" });
  });

  it("ships through the dispatcher on approval, returning per-network receipts", async () => {
    const seen: Array<{ workspaceId: string; approvalRequestId: string; postId: string }> = [];
    const dispatcher: SocialPublishDispatcher = {
      async ship(p, c) {
        seen.push({ ...c, postId: String(p.postId) });
        return {
          postId: String(p.postId),
          status: "published",
          live: true,
          receipts: [
            {
              network: "x",
              status: "published",
              externalRef: "https://x.com/acme/status/1",
              raw: { id: "x-1" },
            },
          ],
        };
      },
    };
    const exec = buildDefaultRegistry(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      dispatcher,
    ).get(SOCIAL_PUBLISH_POST_ACTION)!;

    const result = await exec.execute(payload, ctx);

    expect(seen).toEqual([{ workspaceId: "ws1", approvalRequestId: "appr-1", postId: "post-1" }]);
    expect(result).toMatchObject({
      acknowledged: true,
      postId: "post-1",
      status: "published",
      live: true,
      receipts: [{ network: "x", externalRef: "https://x.com/acme/status/1" }],
    });
  });

  it("passes an empty approval id when ctx has none so the dispatcher can fail closed", async () => {
    let seen = "unset";
    const dispatcher: SocialPublishDispatcher = {
      async ship(_p, c) {
        seen = c.approvalRequestId;
        return null;
      },
    };
    const exec = buildDefaultRegistry(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      dispatcher,
    ).get(SOCIAL_PUBLISH_POST_ACTION)!;

    const result = await exec.execute(payload, {
      workspaceId: "ws1",
      requesterMemberId: "m1",
    } as never);

    expect(seen).toBe("");
    expect(result).toEqual({ acknowledged: true, postId: "post-1" });
  });
});
