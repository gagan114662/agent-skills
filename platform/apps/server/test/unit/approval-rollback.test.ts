import { describe, expect, it } from "vitest";
import { attachApprovalRollbackMetadata } from "../../src/approvals/rollback.js";

describe("approval rollback metadata (#1291)", () => {
  it("preserves provider rollback links returned by executors", () => {
    const result = attachApprovalRollbackMetadata("hosted.publish", {
      executed: true,
      provider: "vercel",
      deploymentId: "dep_123",
      rollbackUrl: "https://vercel.example/rollback/dep_123",
    });

    expect(result.rollback).toMatchObject({
      mode: "provider_link",
      reversible: true,
      url: "https://vercel.example/rollback/dep_123",
      provider: "vercel",
      externalId: "dep_123",
    });
  });

  it("marks recorded-only approvals as having no external side effect to undo", () => {
    const result = attachApprovalRollbackMetadata("browser.action", {
      recorded: true,
      executed: false,
      sessionId: "sess_1",
    });

    expect(result.rollback).toMatchObject({
      mode: "recorded_only",
      reversible: false,
      status: "No external side effect ran from this approval; there is nothing to roll back.",
    });
  });

  it("keeps money movement manual even if a provider id is present", () => {
    const result = attachApprovalRollbackMetadata("billing.refund", {
      recorded: true,
      executed: true,
      provider: "stripe",
      externalId: "re_123",
    });

    expect(result.rollback).toMatchObject({
      mode: "manual",
      reversible: false,
      status: "Money movement is not assumed reversible; approval is the rollback boundary.",
      provider: "stripe",
      externalId: "re_123",
    });
  });
});
