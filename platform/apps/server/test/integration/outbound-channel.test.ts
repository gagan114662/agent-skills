import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces, outboundChannels } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import {
  connectChannel,
  revokeChannel,
  verifyAndRecordSend,
  getChannelConnection,
} from "../../src/outbound-channel/service.js";
import {
  countVerifiedReceipts,
  listSendReceipts,
} from "../../src/db/repositories/outbound-channels.js";
import { tokenFingerprint } from "../../src/crypto/secretbox.js";

/**
 * Integration coverage for the #395 outbound-channel connect + readback-receipt ledger against a real
 * Postgres (the schema is applied by the integration global-setup). Proves: the connect-once step records a
 * connection WITHOUT storing the secret (fingerprint only); the connect refuses with no credential; and the
 * #200 §3 verification path records a verified receipt only for a production-grounded readback.
 */

const wsId = newId();
const memberId = newId();
const slug = `outbound-${Date.now()}`;
const SERVER_TOKEN = "pm-secret-token-do-not-store";
const FROM = "fleet@ipop.test";

beforeAll(async () => {
  await db.insert(workspaces).values({ id: wsId, slug, name: "Outbound Test" });
});

afterAll(async () => {
  // Cascades to outbound_channels + outbound_send_receipts.
  await db.delete(workspaces).where(eq(workspaces.id, wsId));
  await closeDb();
  await closeRedis();
});

describe("#395 outbound channel connect-once", () => {
  it("refuses to connect with no credential, naming the owner-gated manual step", async () => {
    const res = await connectChannel({
      workspaceId: wsId,
      fromAddress: FROM,
      connectedByMemberId: memberId,
      env: {}, // no POSTMARK_SERVER_TOKEN set
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("missing_credential");
      expect(res.error).toContain("POSTMARK_SERVER_TOKEN");
    }
    // No connected row was written.
    expect(await getChannelConnection(wsId, "email_postmark")).toBeNull();
  });

  it("records a connection storing only a fingerprint — never the token", async () => {
    const res = await connectChannel({
      workspaceId: wsId,
      fromAddress: FROM,
      connectedByMemberId: memberId,
      serverToken: SERVER_TOKEN,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.connection.status).toBe("connected");
    expect(res.connection.fromAddress).toBe(FROM);
    expect(res.connection.credentialFingerprint).toBe(tokenFingerprint(SERVER_TOKEN));

    // The raw token is NOWHERE in the persisted row.
    const [raw] = await db.select().from(outboundChannels).where(eq(outboundChannels.workspaceId, wsId));
    expect(JSON.stringify(raw)).not.toContain(SERVER_TOKEN);
    expect(raw?.credentialFingerprint).not.toContain(SERVER_TOKEN);

    const read = await getChannelConnection(wsId, "email_postmark");
    expect(read?.status).toBe("connected");
  });

  it("revokes a connection, dropping the fingerprint and from address", async () => {
    const revoked = await revokeChannel({ workspaceId: wsId });
    expect(revoked.status).toBe("revoked");
    expect(revoked.credentialFingerprint).toBeNull();
    expect(revoked.fromAddress).toBeNull();
    // Re-connect so later assertions about a connected channel hold.
    await connectChannel({
      workspaceId: wsId,
      fromAddress: FROM,
      connectedByMemberId: memberId,
      serverToken: SERVER_TOKEN,
    });
  });
});

describe("#395 readback-receipt verification (#200 §3)", () => {
  const approvalRequestId = newId();
  const recipient = "stranger@example.test";

  it("records a VERIFIED receipt when a production readback returns an ESP message id", async () => {
    const res = await verifyAndRecordSend({
      workspaceId: wsId,
      recipient,
      approvalRequestId,
      probe: async () => ({ messageId: "pm-message-id-123", observedAt: "2026-06-21T12:00:00.000Z" }),
    });
    expect(res.verified).toBe(true);
    expect(res.recorded).toBe(true);
    expect(res.row?.source).toBe("production_readback");
    expect(res.row?.externalRef).toBe("pm-message-id-123");
    expect(res.row?.approvalRequestId).toBe(approvalRequestId);
    expect(await countVerifiedReceipts(wsId, "email_postmark")).toBe(1);
  });

  it("records nothing when no readback is available (never assumes success)", async () => {
    const res = await verifyAndRecordSend({ workspaceId: wsId, recipient, approvalRequestId });
    expect(res.verified).toBe(false);
    expect(res.recorded).toBe(false);
    expect(res.row).toBeNull();
    // Still exactly one verified receipt — the no-readback attempt added nothing.
    expect(await countVerifiedReceipts(wsId, "email_postmark")).toBe(1);
  });

  it("records an UNVERIFIED attempt when a live-URL probe is unreachable (5xx)", async () => {
    const res = await verifyAndRecordSend({
      workspaceId: wsId,
      recipient,
      approvalRequestId,
      probe: async () => ({
        url: "https://ipop.test/confirm",
        httpStatus: 503,
        observedAt: "2026-06-21T12:05:00.000Z",
      }),
    });
    expect(res.verified).toBe(false);
    expect(res.recorded).toBe(true);
    expect(res.row?.verified).toBe(false);
    expect(res.row?.source).toBe("live_url");
    // The unverified row exists but does NOT count toward proven-inbox delivery.
    expect(await countVerifiedReceipts(wsId, "email_postmark")).toBe(1);

    const all = await listSendReceipts(wsId);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const verifiedOnly = await listSendReceipts(wsId, { verifiedOnly: true });
    expect(verifiedOnly.every((r) => r.verified)).toBe(true);
    expect(verifiedOnly.length).toBe(1);
  });
});
