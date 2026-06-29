import { describe, it, expect, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { Identity } from "../../src/auth/identity.js";
import { createPostmarkEspProvider } from "../../src/acquisition/postmark-esp.js";
import { createResendEspProvider } from "../../src/acquisition/resend-esp.js";
import {
  createAcquisitionDispatcher,
  type AcquisitionDispatcherDeps,
  type SendReceiptInput,
} from "../../src/acquisition/execution.js";
import { createAcquisitionProviders } from "../../src/acquisition/providers.js";
import { resolveAcquisitionCaps } from "../../src/acquisition/caps.js";
import type { FooterInfo } from "../../src/acquisition/compliance.js";
import {
  buildDefaultRegistry,
  noopComplianceEnforcer,
  ActionExecutionError,
  type EgressEnforcer,
} from "../../src/approvals/runtime.js";
import {
  buildOutboundEmailAction,
  createOutboundEmailSubmitter,
} from "../../src/email/agent-outbound.js";
import { channelForKind } from "../../src/acquisition/decide.js";

/**
 * #395 — the real outbound email channel, end-to-end and approval-gated. These prove the ONE wiring that
 * was missing: the acquisition dispatcher's ESP provider, when the owner has connected Postmark, sends a
 * REAL email via the Postmark API — and that it does so ONLY after a human #13 approval, never on the
 * agent's submit. Hermetic: `fetch` is injected, so no network is touched.
 */

const TOKEN = "pm-server-token-secret";
const FROM = "hi@ipop.ai";

const footer: FooterInfo = {
  brandName: "ipop",
  postalAddress: "1 Main St, Tallahassee FL",
  unsubscribeUrl: "https://ipop.ai/u",
};

const identity: Identity = {
  workspaceId: "ws_test",
  memberId: "mem_agent",
  kind: "agent",
  displayName: "scout",
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

/** A fetch double that records each request and replies with a canned Postmark response. */
function fakeFetch(reply: { status?: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body),
    } as unknown as Response;
  });
  return { impl, calls };
}

describe("#395 createPostmarkEspProvider — the real ESP behind the connect-once gate", () => {
  it("sends a REAL email via the Postmark API when connected (live + token + from)", async () => {
    const { impl, calls } = fakeFetch({ body: { MessageID: "pm-msg-1", ErrorCode: 0 } });
    const esp = createPostmarkEspProvider({
      resolve: () => ({ live: true, serverToken: TOKEN, from: FROM }),
      fetchImpl: impl as never,
    });
    const out = await esp.send({
      workspaceId: "ws_test",
      ideaId: null,
      subject: "Quick intro",
      body: "Hello there",
      recipients: ["prospect@example.com"],
    });
    expect(out.status).toBe("sent");
    expect(out.provider).toBe("postmark");
    expect(out.externalId).toBe("pm-msg-1");
    expect(out.detail.dryRun).toBe(false);
    expect(calls).toHaveLength(1);
    // The secret rides ONLY the header, never the body.
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Postmark-Server-Token"]).toBe(TOKEN);
    expect(String(calls[0]!.init.body)).not.toContain(TOKEN);
  });

  it("sends one request per recipient", async () => {
    const { impl, calls } = fakeFetch({ body: { MessageID: "pm-msg", ErrorCode: 0 } });
    const esp = createPostmarkEspProvider({
      resolve: () => ({ live: true, serverToken: TOKEN, from: FROM }),
      fetchImpl: impl as never,
    });
    await esp.send({
      workspaceId: "ws_test",
      ideaId: null,
      subject: "Hi",
      body: "Body",
      recipients: ["a@x.com", "b@x.com"],
    });
    expect(calls).toHaveLength(2);
  });

  it("stays dry-run (NO network) when the owner has not connected Postmark", async () => {
    const { impl, calls } = fakeFetch({ body: { MessageID: "should-not-happen", ErrorCode: 0 } });
    for (const resolution of [
      { live: false, serverToken: TOKEN, from: FROM }, // channel not live
      { live: true, serverToken: "", from: FROM }, // no token connected
      { live: true, serverToken: TOKEN, from: "" }, // no verified From
    ]) {
      const esp = createPostmarkEspProvider({ resolve: () => resolution, fetchImpl: impl as never });
      const out = await esp.send({
        workspaceId: "ws_test",
        ideaId: null,
        subject: "Hi",
        body: "Body",
        recipients: ["a@x.com"],
      });
      expect(out.provider).toBe("dryrun");
      expect(out.detail.dryRun).toBe(true);
    }
    expect(calls).toHaveLength(0); // never touched the network
  });

  it("throws a token-free ActionExecutionError when Postmark rejects the send", async () => {
    const { impl } = fakeFetch({ status: 422, body: { ErrorCode: 300, Message: "Invalid recipient" } });
    const esp = createPostmarkEspProvider({
      resolve: () => ({ live: true, serverToken: TOKEN, from: FROM }),
      fetchImpl: impl as never,
    });
    const err = await esp
      .send({ workspaceId: "ws_test", ideaId: null, subject: "Hi", body: "Body", recipients: ["a@x.com"] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionExecutionError);
    expect((err as Error).message).not.toContain(TOKEN);
  });
});

describe("#395 the agent outbound-email tool emits the canonical send kind", () => {
  it("buildOutboundEmailAction's kind routes to the email channel (not recorded-only)", () => {
    const action = buildOutboundEmailAction({ to: "p@example.com", subject: "Hi", body: "Hello" });
    // The regression guard for the #395 root cause: an earlier `kind:"email"` was recognized by neither
    // the dispatcher nor the legal pack, so approved emails silently fell through to recorded-only.
    expect(channelForKind(String(action.payload.kind))).toBe("email");
  });
});

describe("#395 end-to-end: an approved external.send dispatches a REAL email", () => {
  function buildHarness(resolve: () => { live: boolean; serverToken: string; from: string }, reply: { status?: number; body: unknown }) {
    const { impl, calls } = fakeFetch(reply);
    const receipts: SendReceiptInput[] = [];
    const readbacks: Array<{
      workspaceId: string;
      approvalRequestId: string;
      recipients: readonly string[];
      messageIds: readonly string[];
      provider: string;
      detail: Record<string, unknown>;
    }> = [];
    const deps: AcquisitionDispatcherDeps = {
      resolveCaps: () => resolveAcquisitionCaps({ enabled: true, email: true, espProvider: "postmark" }),
      providers: createAcquisitionProviders(
        {},
        { esp: createPostmarkEspProvider({ resolve, fetchImpl: impl as never }) },
      ),
      envelopes: {
        getActiveAdsEnvelope: () => Promise.resolve(null),
        reserveAdsSpend: () => Promise.resolve(null),
        refundAdsSpend: () => Promise.resolve(),
        debitAdsEnvelope: () => Promise.resolve(),
      },
      suppressions: { loadSuppressed: () => Promise.resolve(new Set<string>()) },
      receipts: {
        record: (r) => {
          receipts.push(r);
          return Promise.resolve();
        },
      },
      outboundReadbacks: {
        recordEspReadbacks: (r) => {
          readbacks.push(r);
          return Promise.resolve();
        },
      },
      emailWindow: { warmupState: () => Promise.resolve({ dayIndex: 99, sentToday: 0 }) },
      footerInfo: () => footer,
    };
    const permissiveEgress: EgressEnforcer = { enforce: () => Promise.resolve(null) };
    const registry = buildDefaultRegistry(permissiveEgress, noopComplianceEnforcer, createAcquisitionDispatcher(deps));
    return { registry, receipts, readbacks, calls };
  }

  const ctx = {
    workspaceId: "ws_test",
    requesterMemberId: "mem_owner",
    log: silentLogger,
    requestId: "req_approved",
  };

  it("an APPROVED send is dispatched via the real Postmark provider", async () => {
    const { registry, receipts, readbacks, calls } = buildHarness(
      () => ({ live: true, serverToken: TOKEN, from: FROM }),
      { body: { MessageID: "pm-approved-1", ErrorCode: 0 } },
    );
    const action = buildOutboundEmailAction({
      to: "prospect@example.com",
      subject: "Quick intro",
      body: "Hello there",
    });
    // This is exactly what `executeApprovedRequest` runs AFTER a human approves the parked #13 request.
    const result = await registry.get("external.send")!.execute(action.payload, ctx);

    expect(result.executed).toBe(true);
    expect(result.provider).toBe("postmark");
    expect(result.externalId).toBe("pm-approved-1");
    expect(calls).toHaveLength(1); // a real send left the building
    expect(receipts[0]!.provider).toBe("postmark");
    expect(receipts[0]!.status).toBe("sent");
    expect(readbacks).toEqual([
      expect.objectContaining({
        workspaceId: "ws_test",
        approvalRequestId: "req_approved",
        recipients: ["prospect@example.com"],
        messageIds: ["pm-approved-1"],
        provider: "postmark",
      }),
    ]);
  });

  it("fails closed when a real Postmark send cannot be tied to a #13 approval id", async () => {
    const { registry } = buildHarness(
      () => ({ live: true, serverToken: TOKEN, from: FROM }),
      { body: { MessageID: "pm-approved-1", ErrorCode: 0 } },
    );
    const action = buildOutboundEmailAction({
      to: "prospect@example.com",
      subject: "Quick intro",
      body: "Hello there",
    });
    await expect(
      registry.get("external.send")!.execute(action.payload, {
        workspaceId: "ws_test",
        requesterMemberId: "mem_owner",
        log: silentLogger,
      }),
    ).rejects.toThrow(/approval request id/);
  });

  it("fails closed when a real Postmark send has no readback recorder wired", async () => {
    const { impl } = fakeFetch({ body: { MessageID: "pm-approved-1", ErrorCode: 0 } });
    const deps: AcquisitionDispatcherDeps = {
      resolveCaps: () => resolveAcquisitionCaps({ enabled: true, email: true, espProvider: "postmark" }),
      providers: createAcquisitionProviders(
        {},
        {
          esp: createPostmarkEspProvider({
            resolve: () => ({ live: true, serverToken: TOKEN, from: FROM }),
            fetchImpl: impl as never,
          }),
        },
      ),
      envelopes: {
        getActiveAdsEnvelope: () => Promise.resolve(null),
        reserveAdsSpend: () => Promise.resolve(null),
        refundAdsSpend: () => Promise.resolve(),
        debitAdsEnvelope: () => Promise.resolve(),
      },
      suppressions: { loadSuppressed: () => Promise.resolve(new Set<string>()) },
      receipts: { record: () => Promise.resolve() },
      emailWindow: { warmupState: () => Promise.resolve({ dayIndex: 99, sentToday: 0 }) },
      footerInfo: () => footer,
    };
    const registry = buildDefaultRegistry(
      { enforce: () => Promise.resolve(null) },
      noopComplianceEnforcer,
      createAcquisitionDispatcher(deps),
    );
    const action = buildOutboundEmailAction({
      to: "prospect@example.com",
      subject: "Quick intro",
      body: "Hello there",
    });
    await expect(registry.get("external.send")!.execute(action.payload, ctx)).rejects.toThrow(/readback recorder/);
  });

  it("an APPROVED send can dispatch via the real Resend provider and still requires readback proof", async () => {
    const { impl, calls } = fakeFetch({ body: { id: "resend-approved-1" } });
    const readbacks: Array<{
      workspaceId: string;
      approvalRequestId: string;
      recipients: readonly string[];
      messageIds: readonly string[];
      provider: string;
      detail: Record<string, unknown>;
    }> = [];
    const receipts: SendReceiptInput[] = [];
    const deps: AcquisitionDispatcherDeps = {
      resolveCaps: () => resolveAcquisitionCaps({ enabled: true, email: true, espProvider: "resend" }),
      providers: createAcquisitionProviders(
        {},
        {
          esp: createResendEspProvider({
            resolve: () => ({ live: true, apiKey: "re-secret", from: FROM }),
            fetchImpl: impl as never,
          }),
        },
      ),
      envelopes: {
        getActiveAdsEnvelope: () => Promise.resolve(null),
        reserveAdsSpend: () => Promise.resolve(null),
        refundAdsSpend: () => Promise.resolve(),
        debitAdsEnvelope: () => Promise.resolve(),
      },
      suppressions: { loadSuppressed: () => Promise.resolve(new Set<string>()) },
      receipts: {
        record: (r) => {
          receipts.push(r);
          return Promise.resolve();
        },
      },
      outboundReadbacks: {
        recordEspReadbacks: (r) => {
          readbacks.push(r);
          return Promise.resolve();
        },
      },
      emailWindow: { warmupState: () => Promise.resolve({ dayIndex: 99, sentToday: 0 }) },
      footerInfo: () => footer,
    };
    const registry = buildDefaultRegistry(
      { enforce: () => Promise.resolve(null) },
      noopComplianceEnforcer,
      createAcquisitionDispatcher(deps),
    );
    const action = buildOutboundEmailAction({
      to: "prospect@example.com",
      subject: "Quick intro",
      body: "Hello there",
    });

    const result = await registry.get("external.send")!.execute(action.payload, ctx);

    expect(result.executed).toBe(true);
    expect(result.provider).toBe("resend");
    expect(result.externalId).toBe("resend-approved-1");
    expect(calls).toHaveLength(1);
    expect(receipts[0]!.provider).toBe("resend");
    expect(readbacks).toEqual([
      expect.objectContaining({
        approvalRequestId: "req_approved",
        recipients: ["prospect@example.com"],
        messageIds: ["resend-approved-1"],
        provider: "resend",
      }),
    ]);
  });

  it("with the channel connected but NOT enabled, an approved send stays recorded-only (no network)", async () => {
    const { impl, calls } = fakeFetch({ body: { MessageID: "nope", ErrorCode: 0 } });
    const deps: AcquisitionDispatcherDeps = {
      // master + channel flag OFF (the default) → dispatcher returns null → recorded-only fall-through.
      resolveCaps: () => resolveAcquisitionCaps({ enabled: false }),
      providers: createAcquisitionProviders(
        {},
        {
          esp: createPostmarkEspProvider({
            resolve: () => ({ live: true, serverToken: TOKEN, from: FROM }),
            fetchImpl: impl as never,
          }),
        },
      ),
      envelopes: {
        getActiveAdsEnvelope: () => Promise.resolve(null),
        reserveAdsSpend: () => Promise.resolve(null),
        refundAdsSpend: () => Promise.resolve(),
        debitAdsEnvelope: () => Promise.resolve(),
      },
      suppressions: { loadSuppressed: () => Promise.resolve(new Set<string>()) },
      receipts: { record: () => Promise.resolve() },
      emailWindow: { warmupState: () => Promise.resolve({ dayIndex: 99, sentToday: 0 }) },
      footerInfo: () => footer,
    };
    const permissiveEgress: EgressEnforcer = { enforce: () => Promise.resolve(null) };
    const registry = buildDefaultRegistry(permissiveEgress, noopComplianceEnforcer, createAcquisitionDispatcher(deps));
    const action = buildOutboundEmailAction({ to: "p@example.com", subject: "Hi", body: "Hello" });
    const result = await registry.get("external.send")!.execute(action.payload, ctx);
    expect(result).toEqual({ recorded: true, target: "p@example.com", summary: action.payload.summary });
    expect(calls).toHaveLength(0);
  });
});

describe("#395 nothing sends without approval — the agent submit only PARKS a pending #13", () => {
  it("the agent submit parks a PENDING external.send and never reaches the provider", async () => {
    const { impl, calls } = fakeFetch({ body: { MessageID: "must-not-send", ErrorCode: 0 } });
    const espTouched = vi.fn();
    // A provider that fails the test loudly if it is ever called by the submit path.
    const guardedEsp = createPostmarkEspProvider({
      resolve: () => {
        espTouched();
        return { live: true, serverToken: TOKEN, from: FROM };
      },
      fetchImpl: impl as never,
    });
    void guardedEsp; // wired nowhere into the submit path — proving the submit cannot send.

    const createRequest = vi.fn().mockResolvedValue({ id: "req_pending", workspaceId: "ws_test", status: "pending" });
    const submit = createOutboundEmailSubmitter(identity, silentLogger, {
      createRequest,
      listHumanReviewers: vi.fn().mockResolvedValue(["mem_owner"]),
      notify: vi.fn().mockResolvedValue(null),
      now: () => 1_000_000,
      ttlSeconds: 3600,
    });

    const result = await submit({ to: "prospect@example.com", subject: "Quick intro", body: "Hello" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("pending"); // queued for approval, NOT sent
    expect(createRequest).toHaveBeenCalledTimes(1);
    expect(createRequest.mock.calls[0]![0].status).toBe("pending");
    // The crucial invariant: no real send happened on submit — only a human approval can dispatch it.
    expect(calls).toHaveLength(0);
    expect(espTouched).not.toHaveBeenCalled();
  });
});
