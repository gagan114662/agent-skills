import { describe, it, expect } from "vitest";
import {
  toOutboundReceiptView,
  type StoredSendReceipt,
} from "../../src/outbound-channel/receipt-view.js";

const BASE: StoredSendReceipt & { workspaceId: string; detail: Record<string, unknown> | null } = {
  id: "rcpt-1",
  workspaceId: "ws-owner",
  channel: "email_postmark",
  recipient: "stranger@example.com",
  source: "production_readback",
  externalRef: "pm-message-abc-123",
  httpStatus: null,
  verified: true,
  approvalRequestId: "req-13-xyz",
  detail: { stream: "broadcast", raw: "injected" },
  observedAtMs: 1_750_000_000_000,
  createdAtMs: 1_750_000_001_000,
};

describe("toOutboundReceiptView (#395 §3 dashboard read-back)", () => {
  it("maps an ESP production_readback row to the owner-facing view", () => {
    const view = toOutboundReceiptView(BASE);
    expect(view).toEqual({
      id: "rcpt-1",
      channel: "email_postmark",
      recipient: "stranger@example.com",
      source: "production_readback",
      externalRef: "pm-message-abc-123",
      httpStatus: null,
      verified: true,
      approvalRequestId: "req-13-xyz",
      observedAtMs: 1_750_000_000_000,
      createdAtMs: 1_750_000_001_000,
    });
  });

  it("never leaks the internal workspaceId or the free-form detail blob (#200 §6)", () => {
    const view = toOutboundReceiptView(BASE) as Record<string, unknown>;
    expect(view).not.toHaveProperty("workspaceId");
    expect(view).not.toHaveProperty("detail");
  });

  it("carries a live_url receipt's http status through", () => {
    const view = toOutboundReceiptView({
      ...BASE,
      source: "live_url",
      externalRef: "https://ipop.ai/u/confirm",
      httpStatus: 200,
      verified: true,
    });
    expect(view.source).toBe("live_url");
    expect(view.externalRef).toBe("https://ipop.ai/u/confirm");
    expect(view.httpStatus).toBe(200);
  });

  it("surfaces an unverified attempt as verified:false (never assume a send landed)", () => {
    const view = toOutboundReceiptView({ ...BASE, verified: false });
    expect(view.verified).toBe(false);
  });
});
