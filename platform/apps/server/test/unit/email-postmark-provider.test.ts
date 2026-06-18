import { describe, it, expect, vi } from "vitest";
import {
  PostmarkEspProvider,
  resolvePostmarkSender,
  POSTMARK_API_URL,
} from "../../src/email/postmark-provider.js";
import { dryRunEspSender } from "../../src/reach/channels/email.js";

/** A fetch double that records the request and replies with a canned Postmark response. */
function fakeFetch(reply: { status?: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: (reply.status ?? 200) >= 200 && (reply.status ?? 200) < 300,
      status: reply.status ?? 200,
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body),
    } as unknown as Response;
  });
  return { impl, calls };
}

const TOKEN = "pm-server-token-secret";

describe("resolvePostmarkSender (gated — dry-run is the default)", () => {
  it("returns the dry-run sender when live sending is OFF (no network)", () => {
    const s = resolvePostmarkSender({ live: false, serverToken: TOKEN, from: "hi@ipop.ai" });
    expect(s).toBe(dryRunEspSender);
    expect(s.kind).toBe("dryrun");
  });

  it("returns the dry-run sender when live but no Postmark token is connected", () => {
    const s = resolvePostmarkSender({ live: true, serverToken: "", from: "hi@ipop.ai" });
    expect(s.kind).toBe("dryrun");
  });

  it("returns a live Postmark provider only when live AND a token is connected", () => {
    const s = resolvePostmarkSender({ live: true, serverToken: TOKEN, from: "hi@ipop.ai" });
    expect(s.kind).toBe("postmark");
    expect(s).toBeInstanceOf(PostmarkEspProvider);
  });
});

describe("PostmarkEspProvider.send (real API shape, fetch injected — no network)", () => {
  it("POSTs to the Postmark API and returns the MessageID as the external receipt", async () => {
    const { impl, calls } = fakeFetch({ body: { MessageID: "abc-123", ErrorCode: 0, To: "x@y.com" } });
    const p = new PostmarkEspProvider({ serverToken: TOKEN, from: "hi@ipop.ai", fetchImpl: impl as never });
    const out = await p.send({ to: "x@y.com", subject: "Hi", body: "<p>hi</p>" });

    expect(out.externalId).toBe("abc-123");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(POSTMARK_API_URL);
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("carries the server token ONLY in the X-Postmark-Server-Token header, never in the body", async () => {
    const { impl, calls } = fakeFetch({ body: { MessageID: "m1", ErrorCode: 0 } });
    const p = new PostmarkEspProvider({ serverToken: TOKEN, from: "hi@ipop.ai", fetchImpl: impl as never });
    await p.send({ to: "x@y.com", subject: "Hi", body: "hi" });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Postmark-Server-Token"]).toBe(TOKEN);
    expect(String(calls[0]!.init.body)).not.toContain(TOKEN);
  });

  it("forwards custom MIME headers (RFC 8058 List-Unsubscribe) as Postmark's Headers array", async () => {
    const { impl, calls } = fakeFetch({ body: { MessageID: "m1", ErrorCode: 0 } });
    const p = new PostmarkEspProvider({ serverToken: TOKEN, from: "hi@ipop.ai", fetchImpl: impl as never });
    await p.send({
      to: "x@y.com",
      subject: "Hi",
      body: "hi",
      headers: { "List-Unsubscribe": "<https://ipop.ai/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    const sent = JSON.parse(String(calls[0]!.init.body)) as { Headers: Array<{ Name: string; Value: string }> };
    expect(sent.Headers).toContainEqual({ Name: "List-Unsubscribe", Value: "<https://ipop.ai/u>" });
    expect(sent.Headers).toContainEqual({ Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" });
  });

  it("throws on a Postmark application error (ErrorCode != 0) so the channel records a failure", async () => {
    const { impl } = fakeFetch({ body: { MessageID: "", ErrorCode: 406, Message: "Inactive recipient" } });
    const p = new PostmarkEspProvider({ serverToken: TOKEN, from: "hi@ipop.ai", fetchImpl: impl as never });
    await expect(p.send({ to: "x@y.com", subject: "Hi", body: "hi" })).rejects.toThrow();
  });

  it("throws on a non-2xx HTTP response", async () => {
    const { impl } = fakeFetch({ status: 401, body: { ErrorCode: 10, Message: "bad token" } });
    const p = new PostmarkEspProvider({ serverToken: TOKEN, from: "hi@ipop.ai", fetchImpl: impl as never });
    await expect(p.send({ to: "x@y.com", subject: "Hi", body: "hi" })).rejects.toThrow();
  });

  it("does not leak the server token in a thrown error message", async () => {
    const { impl } = fakeFetch({ status: 401, body: { ErrorCode: 10, Message: "bad token" } });
    const p = new PostmarkEspProvider({ serverToken: TOKEN, from: "hi@ipop.ai", fetchImpl: impl as never });
    await expect(p.send({ to: "x@y.com", subject: "Hi", body: "hi" })).rejects.toThrow(
      expect.not.stringContaining(TOKEN),
    );
  });
});
