import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyEspSignature,
  EspWebhookVerificationError,
  decideEspSuppressions,
  parseEspBody,
} from "../../src/acquisition/webhook.js";

const secret = "whsec_test";
const sign = (body: string) => createHmac("sha256", secret).update(body, "utf8").digest("hex");

describe("verifyEspSignature", () => {
  it("accepts a correct signature", () => {
    const body = '{"x":1}';
    expect(() => verifyEspSignature(body, sign(body), secret)).not.toThrow();
  });
  it("rejects a forged signature", () => {
    expect(() => verifyEspSignature('{"x":1}', "deadbeef", secret)).toThrow(
      EspWebhookVerificationError,
    );
  });
  it("rejects a missing signature", () => {
    expect(() => verifyEspSignature("{}", undefined, secret)).toThrow(EspWebhookVerificationError);
  });
  it("rejects when no secret is configured", () => {
    expect(() => verifyEspSignature("{}", "abc", "")).toThrow(EspWebhookVerificationError);
  });
});

describe("decideEspSuppressions", () => {
  it("maps Postmark bounce + complaint events onto suppressions", () => {
    const out = decideEspSuppressions([
      { email: "a@x.com", RecordType: "Bounce" },
      { email: "B@x.com", RecordType: "SpamComplaint" },
      { email: "ok@x.com", RecordType: "Delivered" },
    ]);
    expect(out).toEqual([
      { recipient: "a@x.com", reason: "bounce", source: "esp:bounce" },
      { recipient: "b@x.com", reason: "complaint", source: "esp:spamcomplaint" },
    ]);
  });

  it("maps SendGrid-style event/recipient fields", () => {
    const out = decideEspSuppressions([{ recipient: "c@x.com", event: "dropped" }]);
    expect(out[0]).toMatchObject({ recipient: "c@x.com", reason: "bounce" });
  });

  it("de-duplicates recipients and skips malformed entries", () => {
    const out = decideEspSuppressions([
      { email: "dup@x.com", type: "Bounce" },
      { email: "DUP@x.com", type: "Bounce" },
      null,
      { type: "Bounce" }, // no email
      "nope",
    ]);
    expect(out).toHaveLength(1);
  });

  it("returns [] for a non-array", () => {
    expect(decideEspSuppressions({})).toEqual([]);
    expect(decideEspSuppressions(null)).toEqual([]);
  });
});

describe("parseEspBody", () => {
  it("wraps a single Postmark object into an array", () => {
    expect(parseEspBody('{"email":"a@x.com","RecordType":"Bounce"}')).toHaveLength(1);
  });
  it("passes an array through", () => {
    expect(parseEspBody("[{},{}]")).toHaveLength(2);
  });
  it("returns [] for malformed JSON", () => {
    expect(parseEspBody("not json")).toEqual([]);
  });
});
