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

  it("lets operators explicitly doctor Resend before acquisition provider env is flipped", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://api.resend.com/domains");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer re-secret");
      return jsonResponse({ object: "list", data: [{ id: "domain-1", name: "ipop.ai" }] });
    });
    const config = parseOutboundDoctorConfig({
      argv: ["--provider", "resend"],
      env: {
        RESEND_API_KEY: "re-secret",
        RELOAD_FLEET_FROM_EMAIL: "hello@ipop.ai",
        RELOAD_REACH_SEND_PROVIDER: "postmark",
        RELOAD_ACQUISITION_ENABLED: "true",
        RELOAD_ACQUISITION_EMAIL: "true",
        RELOAD_ACQUISITION_BRAND_NAME: "ipop",
        RELOAD_ACQUISITION_POSTAL_ADDRESS: "1 Market St, San Francisco, CA",
        RELOAD_ACQUISITION_UNSUBSCRIBE_URL: "https://ipop.ai/unsubscribe",
      },
    });

    const checks = await runOutboundDoctor(config, { fetchImpl });

    expect(config.provider).toBe("resend");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "resend-config", status: "pass" }),
        expect.objectContaining({
          name: "acquisition-email-live",
          status: "fail",
          message: expect.stringContaining("RELOAD_ACQUISITION_ESP_PROVIDER=resend"),
        }),
        expect.objectContaining({ name: "resend-domains", status: "pass" }),
        expect.objectContaining({ name: "resend-send-smoke", status: "warn" }),
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

  it("proves Resend API reachability and skips sends unless --send-smoke is set", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://api.resend.com/domains");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer re-secret");
      expect((init?.headers as Record<string, string>)["User-Agent"]).toBe("ipop-server/1.0");
      return jsonResponse({ object: "list", data: [{ id: "domain-1", name: "ipop.ai" }] });
    });
    const config = parseOutboundDoctorConfig({
      argv: [],
      env: {
        RESEND_API_KEY: "re-secret",
        RELOAD_FLEET_FROM_EMAIL: "hello@ipop.ai",
        RELOAD_ACQUISITION_ENABLED: "true",
        RELOAD_ACQUISITION_EMAIL: "true",
        RELOAD_ACQUISITION_ESP_PROVIDER: "resend",
        RELOAD_ACQUISITION_BRAND_NAME: "ipop",
        RELOAD_ACQUISITION_POSTAL_ADDRESS: "1 Market St, San Francisco, CA",
        RELOAD_ACQUISITION_UNSUBSCRIBE_URL: "https://ipop.ai/unsubscribe",
      },
    });

    const checks = await runOutboundDoctor(config, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "resend-config", status: "pass" }),
        expect.objectContaining({ name: "acquisition-email-live", status: "pass" }),
        expect.objectContaining({ name: "resend-domains", status: "pass" }),
        expect.objectContaining({ name: "resend-send-smoke", status: "warn" }),
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
        "--tracking-ref",
        "ipop_deadbeefdeadbeef",
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
          outboundDeliveryProof: expect.objectContaining({
            channel: "email_postmark",
            provider: "postmark",
            recipient: "founder@example.com",
            approvalRequestId: "",
            trackingRef: "ipop_deadbeefdeadbeef",
            receipt: expect.objectContaining({
              source: "production_readback",
              externalRef: "pm-123",
            }),
          }),
        }),
        expect.objectContaining({
          name: "outbound-proof-ledger",
          status: "warn",
          message: expect.stringContaining("--workspace-id and --approval-request-id"),
        }),
      ]),
    );
  });

  it("sends an explicit Resend smoke message and returns a Resend proof", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const value = String(url);
      if (value.endsWith("/domains")) return jsonResponse({ object: "list", data: [] });
      expect(value).toBe("https://api.resend.com/emails");
      const body = JSON.parse(String(init?.body)) as {
        to?: string[];
        from?: string;
        subject?: string;
        text?: string;
        headers?: Record<string, string>;
      };
      expect(body).toMatchObject({
        to: ["founder@example.com"],
        from: "hello@ipop.ai",
        subject: "doctor subject",
        text: "doctor smoke",
      });
      expect(body.headers).toMatchObject({ "X-ipop-Proof": "outbound-doctor-smoke" });
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer re-secret");
      return jsonResponse({ id: "resend-123" });
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
        "--tracking-ref",
        "ipop_deadbeefdeadbeef",
      ],
      env: {
        RESEND_API_KEY: "re-secret",
        RELOAD_FLEET_FROM_EMAIL: "hello@ipop.ai",
        RELOAD_ACQUISITION_ENABLED: "true",
        RELOAD_ACQUISITION_EMAIL: "true",
        RELOAD_ACQUISITION_ESP_PROVIDER: "resend",
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
          name: "resend-send-smoke",
          status: "pass",
          message: expect.stringContaining("resend-123"),
          outboundDeliveryProof: expect.objectContaining({
            channel: "email_resend",
            provider: "resend",
            receipt: expect.objectContaining({
              source: "production_readback",
              externalRef: "resend-123",
            }),
          }),
        }),
      ]),
    );
  });

  it("refuses proof JSON smoke sends without approval, workspace, and tracking evidence", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const value = String(url);
      expect(value).toBe("https://api.postmarkapp.com/server");
      return jsonResponse({ ID: 42, Name: "ipop production" });
    });
    const config = parseOutboundDoctorConfig({
      argv: [
        "--send-smoke",
        "--to",
        "buyer@realcompany.com",
        "--workspace-id",
        "00000000-0000-4000-8000-000000000001",
        "--proof-json",
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

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "outbound-proof-json",
          status: "fail",
          message: expect.stringContaining("--approval-request-id"),
        }),
      ]),
    );
  });

  it("records the Postmark smoke readback when workspace and approval proof are provided", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const value = String(url);
      if (value.endsWith("/server")) return jsonResponse({ ID: 42, Name: "ipop production" });
      return jsonResponse({ ErrorCode: 0, MessageID: "pm-proof-456" });
    });
    const verifyAndRecordSend = vi.fn(async () => ({
      verified: true,
      recorded: true,
      receipt: {
        source: "production_readback" as const,
        externalRef: "pm-proof-456",
        observedAt: "2026-06-28T00:00:00.000Z",
      },
      row: {
        id: "receipt-row-1",
        workspaceId: "00000000-0000-4000-8000-000000000001",
        channel: "email_postmark" as const,
        approvalRequestId: "00000000-0000-4000-8000-000000000013",
        recipient: "buyer@realcompany.com",
        source: "production_readback" as const,
        externalRef: "pm-proof-456",
        httpStatus: null,
        verified: true,
        detail: null,
        observedAtMs: 0,
        createdAtMs: 0,
      },
    }));
    const config = parseOutboundDoctorConfig({
      argv: [
        "--send-smoke",
        "--to",
        "buyer@realcompany.com",
        "--workspace-id",
        "00000000-0000-4000-8000-000000000001",
        "--approval-request-id",
        "00000000-0000-4000-8000-000000000013",
        "--tracking-ref",
        "ipop_deadbeefdeadbeef",
        "--proof-json",
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

    const checks = await runOutboundDoctor(config, { fetchImpl, verifyAndRecordSend });

    expect(config.proofJson).toBe(true);
    expect(verifyAndRecordSend).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      channel: "email_postmark",
      recipient: "buyer@realcompany.com",
      approvalRequestId: "00000000-0000-4000-8000-000000000013",
      probe: expect.any(Function),
    });
    const probe = verifyAndRecordSend.mock.calls[0]?.[0].probe;
    await expect(
      probe?.({
        workspaceId: "00000000-0000-4000-8000-000000000001",
        channel: "email_postmark",
        recipient: "buyer@realcompany.com",
        approvalRequestId: "00000000-0000-4000-8000-000000000013",
      }),
    ).resolves.toMatchObject({
      messageId: "pm-proof-456",
      detail: { provider: "postmark", source: "outbound-doctor-smoke" },
    });
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "outbound-proof-ledger",
          status: "pass",
          message: expect.stringContaining("receipt-row-1"),
          outboundDeliveryProof: expect.objectContaining({
            approvalRequestId: "00000000-0000-4000-8000-000000000013",
            recipient: "buyer@realcompany.com",
            trackingRef: "ipop_deadbeefdeadbeef",
            receipt: expect.objectContaining({
              source: "production_readback",
              externalRef: "pm-proof-456",
            }),
          }),
        }),
      ]),
    );
  });
});
