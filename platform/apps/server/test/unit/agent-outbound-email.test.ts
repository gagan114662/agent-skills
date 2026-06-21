import { describe, it, expect, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { Identity } from "../../src/auth/identity.js";
import {
  validateOutboundEmail,
  buildOutboundEmailAction,
  createOutboundEmailSubmitter,
  OUTBOUND_EMAIL_KIND,
} from "../../src/email/agent-outbound.js";

/**
 * Unit coverage for the #463 agent outbound-email tool — the first real outbound execution path an
 * agent can initiate. Hermetic: the repository/notify IO is injected, so these prove the SHAPE (a
 * well-formed, always-gated `external.send` of kind email) and the INVARIANT (an outbound email is
 * NEVER sent autonomously — every submit parks a PENDING #13 owner approval) with no DB.
 */

const identity: Identity = {
  workspaceId: "ws_test",
  memberId: "mem_agent",
  kind: "agent",
  displayName: "echo",
};

const silentLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  fatal() {},
  trace() {},
  child() {
    return silentLogger;
  },
  level: "silent",
} as unknown as FastifyBaseLogger;

describe("#463 validateOutboundEmail", () => {
  it("accepts a well-formed email and normalizes/trims the inputs", () => {
    const v = validateOutboundEmail({
      to: "  Prospect@Example.COM ",
      subject: "  Quick intro  ",
      body: "  Hi there — wanted to reach out.  ",
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.to).toBe("prospect@example.com");
    expect(v.subject).toBe("Quick intro");
    expect(v.body).toBe("Hi there — wanted to reach out.");
  });

  it("rejects a recipient that is not a valid email address", () => {
    for (const to of ["", "not-an-email", "missing@domain", "a b@c.com", "@nope.com"]) {
      const v = validateOutboundEmail({ to, subject: "Hi", body: "Body" });
      expect(v.ok).toBe(false);
    }
  });

  it("requires a non-empty subject and body", () => {
    expect(validateOutboundEmail({ to: "a@b.com", subject: "   ", body: "Body" }).ok).toBe(false);
    expect(validateOutboundEmail({ to: "a@b.com", subject: "Hi", body: "   " }).ok).toBe(false);
  });

  it("bounds the subject and body length", () => {
    expect(
      validateOutboundEmail({ to: "a@b.com", subject: "x".repeat(999), body: "Body" }).ok,
    ).toBe(false);
    expect(
      validateOutboundEmail({ to: "a@b.com", subject: "Hi", body: "x".repeat(100_000) }).ok,
    ).toBe(false);
  });
});

describe("#463 buildOutboundEmailAction", () => {
  it("shapes the existing external.send executor payload (kind email + recipient)", () => {
    const action = buildOutboundEmailAction({
      to: "prospect@example.com",
      subject: "Quick intro",
      body: "Hello",
    });
    expect(action.actionType).toBe("external.send");
    expect(action.payload.kind).toBe(OUTBOUND_EMAIL_KIND);
    expect(action.payload.recipients).toEqual(["prospect@example.com"]);
    // `target` lets the #151 egress allowlist see the recipient; the dispatcher reads `recipients`.
    expect(action.payload.target).toBe("prospect@example.com");
    expect(action.payload.subject).toBe("Quick intro");
    expect(action.payload.body).toBe("Hello");
    expect(action.summary).toContain("prospect@example.com");
  });
});

describe("#463 createOutboundEmailSubmitter — always parks a PENDING owner approval", () => {
  function fakeRequest() {
    return { id: "req_1", workspaceId: "ws_test", status: "pending" } as never;
  }

  it("creates a PENDING external.send request and never auto-approves or executes", async () => {
    const createRequest = vi.fn().mockResolvedValue(fakeRequest());
    const listHumanReviewers = vi.fn().mockResolvedValue(["mem_owner"]);
    const notify = vi.fn().mockResolvedValue(null);

    const submit = createOutboundEmailSubmitter(identity, silentLogger, {
      createRequest,
      listHumanReviewers,
      notify,
      now: () => 1_000_000,
      ttlSeconds: 3600,
    });

    const result = await submit({
      to: "prospect@example.com",
      subject: "Quick intro",
      body: "Hello",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("pending");
    expect(result.requestId).toBe("req_1");

    expect(createRequest).toHaveBeenCalledTimes(1);
    const arg = createRequest.mock.calls[0]![0];
    // The structural always-gate: an outbound email is irreversible, so it is created PENDING — never
    // "executed", never "approved" (no autonomous send path, matching outreach.send / email.live_send).
    expect(arg.status).toBe("pending");
    expect(arg.actionType).toBe("external.send");
    expect(arg.payload.kind).toBe(OUTBOUND_EMAIL_KIND);
    expect(arg.payload.recipients).toEqual(["prospect@example.com"]);
    expect(arg.requesterMemberId).toBe("mem_agent");
    expect(arg.expiresAt).toBeInstanceOf(Date);
    expect(arg.expiresAt.getTime()).toBe(1_000_000 + 3600 * 1000);

    // The owner (a human reviewer) is alerted that a decision is needed.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![1]).toMatchObject({
      recipientMemberId: "mem_owner",
      type: "approval",
      actorMemberId: "mem_agent",
    });
  });

  it("rejects an invalid email WITHOUT parking anything (no request, no send)", async () => {
    const createRequest = vi.fn();
    const submit = createOutboundEmailSubmitter(identity, silentLogger, {
      createRequest,
      listHumanReviewers: vi.fn().mockResolvedValue([]),
      notify: vi.fn(),
    });
    const result = await submit({ to: "not-an-email", subject: "Hi", body: "Body" });
    expect(result.ok).toBe(false);
    expect(createRequest).not.toHaveBeenCalled();
  });
});
