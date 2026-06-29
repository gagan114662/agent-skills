import { describe, expect, it, vi } from "vitest";
import { RESEND_API_URL, ResendEspProvider, resolveResendSender } from "../../src/email/resend-provider.js";
import { dryRunEspSender } from "../../src/reach/channels/email.js";

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

const API_KEY = "re_secret_api_key";

describe("resolveResendSender (gated - dry-run is the default)", () => {
  it("returns dry-run unless live, key, and sender are all present", () => {
    expect(resolveResendSender({ live: false, apiKey: API_KEY, from: "hi@ipop.ai" })).toBe(dryRunEspSender);
    expect(resolveResendSender({ live: true, apiKey: "", from: "hi@ipop.ai" }).kind).toBe("dryrun");
    expect(resolveResendSender({ live: true, apiKey: API_KEY, from: "" }).kind).toBe("dryrun");
  });

  it("returns a live Resend provider only when fully connected", () => {
    const sender = resolveResendSender({ live: true, apiKey: API_KEY, from: "hi@ipop.ai" });
    expect(sender.kind).toBe("resend");
    expect(sender).toBeInstanceOf(ResendEspProvider);
  });
});

describe("ResendEspProvider.send (real API shape, fetch injected - no network)", () => {
  it("POSTs to the Resend API and returns the id as the external receipt", async () => {
    const { impl, calls } = fakeFetch({ body: { id: "email-123" } });
    const provider = new ResendEspProvider({ apiKey: API_KEY, from: "hi@ipop.ai", fetchImpl: impl as never });

    const out = await provider.send({ to: "x@y.com", subject: "Hi", body: "<p>hi</p>" });

    expect(out.externalId).toBe("email-123");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(RESEND_API_URL);
    expect(calls[0]!.init.method).toBe("POST");
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: "hi@ipop.ai",
      to: ["x@y.com"],
      subject: "Hi",
      html: "<p>hi</p>",
    });
  });

  it("carries the API key only in the Authorization header and sends a User-Agent", async () => {
    const { impl, calls } = fakeFetch({ body: { id: "email-123" } });
    const provider = new ResendEspProvider({ apiKey: API_KEY, from: "hi@ipop.ai", fetchImpl: impl as never });

    await provider.send({ to: "x@y.com", subject: "Hi", body: "hi" });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer " + API_KEY);
    expect(headers["User-Agent"]).toBe("ipop-server/1.0");
    expect(String(calls[0]!.init.body)).not.toContain(API_KEY);
  });

  it("forwards custom headers in Resend's headers object", async () => {
    const { impl, calls } = fakeFetch({ body: { id: "email-123" } });
    const provider = new ResendEspProvider({ apiKey: API_KEY, from: "hi@ipop.ai", fetchImpl: impl as never });

    await provider.send({
      to: "x@y.com",
      subject: "Hi",
      body: "hi",
      headers: { "List-Unsubscribe": "<https://ipop.ai/u>" },
    });

    const body = JSON.parse(String(calls[0]!.init.body)) as { headers?: Record<string, string> };
    expect(body.headers).toEqual({ "List-Unsubscribe": "<https://ipop.ai/u>" });
  });

  it("does not leak the API key in a thrown error message", async () => {
    const { impl } = fakeFetch({ status: 401, body: { message: "bad key" } });
    const provider = new ResendEspProvider({ apiKey: API_KEY, from: "hi@ipop.ai", fetchImpl: impl as never });

    await expect(provider.send({ to: "x@y.com", subject: "Hi", body: "hi" })).rejects.toThrow(
      expect.not.stringContaining(API_KEY),
    );
  });
});
