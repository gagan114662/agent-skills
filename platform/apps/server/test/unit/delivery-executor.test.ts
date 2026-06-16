import { describe, it, expect } from "vitest";
import { buildDefaultRegistry } from "../../src/approvals/runtime.js";
import type { DeliveryDispatcher } from "../../src/delivery/dispatcher.js";

/**
 * #295 — the `agent.deliverable` executor wiring. The OWNER's approval is the ship trigger when a delivery
 * dispatcher is wired (default-OFF behind a flag), and a pure acknowledgement otherwise. Three properties:
 *  1. no dispatcher → unchanged acknowledgement (#248 behavior preserved);
 *  2. dispatcher that returns null (not eligible / flag off) → acknowledgement, never a half-shipped state;
 *  3. dispatcher that ships → the result reports what shipped, and the approval id is threaded through.
 */
describe("agent.deliverable ship wiring (#295)", () => {
  const payload = { sessionId: "019ecc61-19eb-75c2-b07d-892c633ab05c", channelId: "c1", draft: "draft" };
  const ctx = { workspaceId: "ws1", requesterMemberId: "m1", requestId: "req-1" } as never;

  it("acknowledges with NO dispatcher (today's behavior — publishing untouched)", async () => {
    const exec = buildDefaultRegistry().get("agent.deliverable")!;
    const result = await exec.execute(payload, ctx);
    expect(result).toEqual({ acknowledged: true, sessionId: payload.sessionId });
  });

  it("acknowledges when the dispatcher declines to ship (returns null)", async () => {
    const dispatcher: DeliveryDispatcher = { ship: () => Promise.resolve(null) };
    const exec = buildDefaultRegistry(undefined, undefined, undefined, dispatcher).get("agent.deliverable")!;
    const result = await exec.execute(payload, ctx);
    expect(result).toEqual({ acknowledged: true, sessionId: payload.sessionId });
  });

  it("reports the ship result when the dispatcher ships, threading the approval id through", async () => {
    let seenApprovalId = "";
    const dispatcher: DeliveryDispatcher = {
      ship: (_p, c) => {
        seenApprovalId = c.approvalRequestId;
        return Promise.resolve({
          shipped: true,
          channel: "publish",
          reversibility: "reversible",
          provider: "github_pages",
          live: true,
          externalRef: "https://ipop.ai/p/launch",
          receiptId: "r1",
        });
      },
    };
    const exec = buildDefaultRegistry(undefined, undefined, undefined, dispatcher).get("agent.deliverable")!;
    const result = await exec.execute(payload, ctx);
    expect(seenApprovalId).toBe("req-1");
    expect(result).toMatchObject({
      acknowledged: true,
      sessionId: payload.sessionId,
      shipped: true,
      channel: "publish",
      live: true,
      externalRef: "https://ipop.ai/p/launch",
      receiptId: "r1",
    });
  });

  it("passes an EMPTY approval id when ctx has none — the dispatcher's fail-closed guard then declines", async () => {
    let seen = "unset";
    const dispatcher: DeliveryDispatcher = {
      ship: (_p, c) => {
        seen = c.approvalRequestId;
        return Promise.resolve(null);
      },
    };
    const exec = buildDefaultRegistry(undefined, undefined, undefined, dispatcher).get("agent.deliverable")!;
    await exec.execute(payload, { workspaceId: "ws1", requesterMemberId: "m1" } as never);
    expect(seen).toBe("");
  });
});
