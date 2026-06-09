import { describe, it, expect } from "vitest";
import { egressAllowed } from "../../src/config/egress.js";
import { createBraintrustTracer } from "../../src/observability/braintrust.js";
import { noopTracer } from "../../src/observability/tracing.js";
import {
  selectTransport,
  NoopTransport,
  WebhookTransport,
} from "../../src/notifications/transport.js";

/**
 * Data-privacy mode wired through (#58): when on, off-platform data egress is disabled. The single
 * policy helper `egressAllowed` gates the two egress points — the Braintrust tracer and the
 * notification webhook transport.
 */
describe("egressAllowed (#58 data-privacy policy)", () => {
  it("is false under data-privacy mode, true otherwise", () => {
    expect(egressAllowed({ dataPrivacyMode: true })).toBe(false);
    expect(egressAllowed({ dataPrivacyMode: false })).toBe(true);
  });
});

describe("Braintrust tracer gate (#58)", () => {
  it("returns the no-op tracer under data-privacy mode (no external export)", () => {
    expect(createBraintrustTracer({ dataPrivacyMode: true })).toBe(noopTracer);
  });

  it("without privacy mode and no API key, stays the no-op tracer (unchanged behavior)", () => {
    // No BRAINTRUST_API_KEY in the test env → still no-op; the privacy gate is independent of it.
    expect(createBraintrustTracer({ dataPrivacyMode: false })).toBe(noopTracer);
  });
});

describe("notification transport gate (#58)", () => {
  it("forces the no-op transport under data-privacy mode even when a webhook URL is set", () => {
    expect(selectTransport("https://hooks.example/x", { dataPrivacyMode: true })).toBeInstanceOf(
      NoopTransport,
    );
  });

  it("uses the webhook transport when egress is allowed and a URL is set (unchanged behavior)", () => {
    expect(selectTransport("https://hooks.example/x")).toBeInstanceOf(WebhookTransport);
    expect(selectTransport("https://hooks.example/x", { dataPrivacyMode: false })).toBeInstanceOf(
      WebhookTransport,
    );
  });

  it("is still a no-op when no URL is configured", () => {
    expect(selectTransport(undefined)).toBeInstanceOf(NoopTransport);
  });
});
