/**
 * Unit tests for the outreach providers and env caps (#595). Covers the deterministic sandbox, the real
 * adapter's no-credential / no-transport / wired-transport behavior, and the default-OFF env resolution.
 */

import { describe, it, expect } from "vitest";
import {
  FakeLinkedInProvider,
  RealLinkedInAdapter,
  createFakeProvider,
  createRealProvider,
  type OutreachTransport,
} from "../../src/linkedin-outreach/provider.js";
import {
  resolveLinkedInOutreachCaps,
  DEFAULT_DAILY_SEND_LIMIT,
  LINKEDIN_OUTREACH_DEFAULTS,
} from "../../src/linkedin-outreach/caps.js";
import type { ProviderSendInput } from "../../src/linkedin-outreach/types.js";

const INPUT: ProviderSendInput = {
  kind: "connection",
  prospectRef: "urn:li:person:1",
  body: "Hi Dana, would love to connect.",
  credential: null,
};

describe("FakeLinkedInProvider (#595)", () => {
  it("returns sent with a deterministic external id (no network)", async () => {
    const p = createFakeProvider();
    const a = await p.send(INPUT);
    const b = await p.send(INPUT);
    expect(a.status).toBe("sent");
    expect(a.externalId).toBeTruthy();
    expect(a.externalId).toBe(b.externalId);
    expect(a.externalId).toMatch(/^fake_li_connection_/);
  });

  it("produces different ids for different bodies", async () => {
    const p = new FakeLinkedInProvider();
    const a = await p.send(INPUT);
    const b = await p.send({ ...INPUT, body: "different body" });
    expect(a.externalId).not.toBe(b.externalId);
  });
});

describe("RealLinkedInAdapter (#595)", () => {
  it("is a no-op (failed) with no credential — never an OAuth attempt", async () => {
    const out = await createRealProvider().send(INPUT);
    expect(out.status).toBe("failed");
    expect(out.externalId).toBeNull();
    expect(out.error).toBe("no credentials");
  });

  it("is a no-op (failed) with a credential but no transport wired", async () => {
    const out = await new RealLinkedInAdapter().send({ ...INPUT, credential: "tok-1" });
    expect(out.status).toBe("failed");
    expect(out.error).toBe("no transport configured");
  });

  it("sends via an injected transport when credential + transport are present", async () => {
    const transport: OutreachTransport = {
      async send() {
        return { externalId: "li-real-1" };
      },
    };
    const out = await createRealProvider(transport).send({ ...INPUT, credential: "tok-1" });
    expect(out.status).toBe("sent");
    expect(out.externalId).toBe("li-real-1");
  });

  it("records a thrown transport as a failed outcome", async () => {
    const transport: OutreachTransport = {
      async send() {
        throw new Error("429 throttled");
      },
    };
    const out = await createRealProvider(transport).send({ ...INPUT, credential: "tok-1" });
    expect(out.status).toBe("failed");
    expect(out.error).toBe("429 throttled");
  });
});

describe("resolveLinkedInOutreachCaps (#595)", () => {
  it("defaults to OFF with the default daily limit and no credential", () => {
    const caps = resolveLinkedInOutreachCaps({});
    expect(caps).toEqual(LINKEDIN_OUTREACH_DEFAULTS);
    expect(caps.enabled).toBe(false);
    expect(caps.dailySendLimit).toBe(DEFAULT_DAILY_SEND_LIMIT);
    expect(caps.credential).toBeNull();
  });

  it("parses the master switch, daily limit, and token from env", () => {
    const caps = resolveLinkedInOutreachCaps({
      LINKEDIN_OUTREACH_ENABLED: "true",
      LINKEDIN_OUTREACH_DAILY_LIMIT: "35",
      LINKEDIN_OUTREACH_TOKEN: "  tok-9  ",
    });
    expect(caps.enabled).toBe(true);
    expect(caps.dailySendLimit).toBe(35);
    expect(caps.credential).toBe("tok-9");
  });

  it("falls back to the default for a blank/invalid/non-positive daily limit", () => {
    expect(resolveLinkedInOutreachCaps({ LINKEDIN_OUTREACH_DAILY_LIMIT: "0" }).dailySendLimit).toBe(
      DEFAULT_DAILY_SEND_LIMIT,
    );
    expect(resolveLinkedInOutreachCaps({ LINKEDIN_OUTREACH_DAILY_LIMIT: "nope" }).dailySendLimit).toBe(
      DEFAULT_DAILY_SEND_LIMIT,
    );
    expect(resolveLinkedInOutreachCaps({ LINKEDIN_OUTREACH_DAILY_LIMIT: "-5" }).dailySendLimit).toBe(
      DEFAULT_DAILY_SEND_LIMIT,
    );
  });

  it("treats a whitespace-only token as absent", () => {
    expect(resolveLinkedInOutreachCaps({ LINKEDIN_OUTREACH_TOKEN: "   " }).credential).toBeNull();
  });
});
