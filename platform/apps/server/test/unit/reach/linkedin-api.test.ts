import { describe, expect, it } from "vitest";
import {
  createLinkedInApiSender,
  type LinkedInApiFetch,
} from "../../../src/reach/channels/linkedin-api.js";

describe("LinkedIn permitted API sender (#856)", () => {
  it("posts to the configured API gateway with the vault token and returns the external id", async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | undefined }> = [];
    const fetchImpl: LinkedInApiFetch = async (url, init) => {
      calls.push({
        url,
        body: JSON.parse(init.body),
        auth: init.headers.authorization,
      });
      return { ok: true, status: 200, json: async () => ({ messageId: "li-msg-1" }) };
    };
    const sender = createLinkedInApiSender({
      token: "li-token",
      baseUrl: "https://api.linkedin.example/",
      fetchImpl,
    });

    await expect(sender.send({ to: "https://linkedin.com/in/jane", body: "hi" })).resolves.toEqual({
      externalId: "li-msg-1",
    });
    expect(calls).toEqual([
      {
        url: "https://api.linkedin.example/messages",
        body: { to: "https://linkedin.com/in/jane", body: "hi" },
        auth: "Bearer li-token",
      },
    ]);
  });

  it("fails closed when the API rejects or omits a receipt id", async () => {
    const rejected = createLinkedInApiSender({
      token: "li-token",
      baseUrl: "https://api.linkedin.example",
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    });
    await expect(rejected.send({ to: "li", body: "hi" })).rejects.toThrow(/403/);

    const noReceipt = createLinkedInApiSender({
      token: "li-token",
      baseUrl: "https://api.linkedin.example",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    });
    await expect(noReceipt.send({ to: "li", body: "hi" })).rejects.toThrow(/external id/i);
  });
});
