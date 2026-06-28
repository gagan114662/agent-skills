import { describe, expect, it, vi } from "vitest";
import {
  parseOutboundDoctorConfig,
  runOutboundDoctor,
} from "../../src/outbound-channel/outbound-doctor-cli.js";

function jsonResponse(payload: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("outbound doctor CLI (#395)", () => {
  it("reports missing Postmark and acquisition config without touching the provider", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const config = parseOutboundDoctorConfig({ env: {}, argv: [] });

    const checks = await runOutboundDoctor(config, { fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "postmark-config",
          status: "fail",
          message: expect.stringContaining("POSTMARK_SERVER_TOKEN"),
        }),
        expect.objectContaining({
          name: "acquisition-email-live",
          status: "fail",
          message: expect.stringContaining("RELOAD_ACQUISITION_ESP_PROVIDER=postmark"),
        }),
        expect.objectContaining({
          name: "acquisition-compliance",
          status: "fail",
          message: expect.stringContaining("RELOAD_ACQUISITION_UNSUBSCRIBE_URL"),
        }),
      ]),
    );
  });

  it("proves Postmark server identity and skips sends unless --send-smoke is set", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      expect(String(url)).toBe("https://api.postmarkapp.com/server");
      return jsonResponse({ ID: 42, Name: "ipop production" });
    });
    const config = parseOutboundDoctorConfig({
      argv: [],
      env: {
        POSTMARK_SERVER_TOKEN: "pm-secret",
        POSTMARK_FROM: "hello@ipop.ai",
        RELOAD_ACQUISITION_ENABLED: "true",
        RELOAD_ACQUISITION_EMAIL: "true",
        RELOAD_ACQUISITION_ESP_PROVIDER: "postmark",
        RELOAD_ACQUISITION_BRAND_NAME: "ipop",
        RELOAD_ACQUISITION_POSTAL_ADDRESS: "1 Market St, San Francisco, CA",
        RELOAD_ACQUISITION_UNSUBSCRIBE_URL: "https://ipop.ai/unsubscribe",
      },
    });

    const checks = await runOutboundDoctor(config, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "postmark-config", status: "pass" }),
        expect.objectContaining({ name: "acquisition-email-live", status: "pass" }),
        expect.objectContaining({ name: "acquisition-compliance", status: "pass" }),
        expect.objectContaining({
          name: "postmark-server",
          status: "pass",
          message: expect.stringContaining("ipop production"),
        }),
        expect.objectContaining({ name: "postmark-send-smoke", status: "warn" }),
      ]),
    );
  });

  it("sends an explicit smoke message only when requested", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const value = String(url);
      if (value.endsWith("/server")) return jsonResponse({ ID: 42, Name: "ipop production" });
      expect(value).toBe("https://api.postmarkapp.com/email");
      const body = JSON.parse(String(init?.body)) as {
        To?: string;
        From?: string;
        Subject?: string;
        TextBody?: string;
        Headers?: Array<{ Name: string; Value: string }>;
      };
      expect(body).toMatchObject({
        To: "founder@example.com",
        From: "hello@ipop.ai",
        Subject: "doctor subject",
        TextBody: "doctor smoke",
      });
      expect(body.Headers).toContainEqual({ Name: "X-ipop-Proof", Value: "outbound-doctor-smoke" });
      expect((init?.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe(
        "pm-secret",
      );
      return jsonResponse({ ErrorCode: 0, MessageID: "pm-123" });
    });
    const config = parseOutboundDoctorConfig({
      argv: [
        "--send-smoke",
        "--to",
        "founder@example.com",
        "--subject",
        "doctor subject",
        "--text",
        "doctor smoke",
      ],
      env: {
        POSTMARK_SERVER_TOKEN: "pm-secret",
        POSTMARK_FROM: "hello@ipop.ai",
        RELOAD_ACQUISITION_ENABLED: "true",
        RELOAD_ACQUISITION_EMAIL: "true",
        RELOAD_ACQUISITION_ESP_PROVIDER: "postmark",
        RELOAD_ACQUISITION_BRAND_NAME: "ipop",
        RELOAD_ACQUISITION_POSTAL_ADDRESS: "1 Market St, San Francisco, CA",
        RELOAD_ACQUISITION_UNSUBSCRIBE_URL: "https://ipop.ai/unsubscribe",
      },
    });

    const checks = await runOutboundDoctor(config, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "postmark-send-smoke",
          status: "pass",
          message: expect.stringContaining("pm-123"),
        }),
      ]),
    );
  });
});
