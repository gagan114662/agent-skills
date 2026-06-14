import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import {
  upsertBudgetEnvelope,
  dbEnvelopeStore,
  dbReceiptStore,
  dbSuppressionStore,
  addSuppression,
  spendByChannelSince,
  failingChannelsSince,
  conversionsByChannelSince,
  emailWarmupState,
} from "../../src/db/repositories/acquisition.js";

/**
 * #189 — Acquisition execution over the real DB: the owner-approved budget envelope (load + debit +
 * exhaust), the external-grounded send receipts (spend rollup + failing channels + conversions), and the
 * email suppression list. Proves the 0189 migration's tables + the repo against real Postgres.
 */
const wsId = newId();
const slug = `acq-${Date.now()}`;

beforeAll(async () => {
  await db.insert(workspaces).values({ id: wsId, slug, name: "Acq Test" });
});

afterAll(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, wsId));
  await closeDb();
  await closeRedis();
});

describe("budget envelope (AC1)", () => {
  it("upserts, loads the active envelope, and debits it (exhausting at the cap)", async () => {
    await upsertBudgetEnvelope({
      workspaceId: wsId,
      ideaId: null,
      periodKey: "2026-06",
      capCents: 10_000,
      status: "active",
    });
    const env = await dbEnvelopeStore.getActiveAdsEnvelope(wsId, null);
    expect(env).not.toBeNull();
    expect(env!.capCents).toBe(10_000);
    expect(env!.status).toBe("active");

    await dbEnvelopeStore.debitAdsEnvelope(wsId, null, 4_000);
    const after = await dbEnvelopeStore.getActiveAdsEnvelope(wsId, null);
    expect(after!.spentCents).toBe(4_000);

    // Debit the rest → the envelope flips to exhausted and is no longer "active".
    await dbEnvelopeStore.debitAdsEnvelope(wsId, null, 6_000);
    expect(await dbEnvelopeStore.getActiveAdsEnvelope(wsId, null)).toBeNull();
  });
});

describe("send receipts (AC1/AC3/AC5)", () => {
  it("records receipts and rolls spend + conversions + failures by channel", async () => {
    const since = new Date(Date.now() - 60_000);
    await dbReceiptStore.record({
      workspaceId: wsId,
      ideaId: null,
      channel: "ads",
      kind: "ad.spend",
      provider: "dryrun",
      status: "sent",
      externalId: "dryrun:abc",
      amountCents: 2_500,
      recipientCount: 0,
      detail: { conversions: 5, conversionsVerified: true },
    });
    await dbReceiptStore.record({
      workspaceId: wsId,
      ideaId: null,
      channel: "social",
      kind: "social.post",
      provider: "dryrun",
      status: "failed",
      externalId: null,
      amountCents: null,
      recipientCount: 0,
      detail: { error: "rate limited" },
    });

    const spend = await spendByChannelSince(wsId, since);
    expect(spend.find((s) => s.channel === "ads")!.spentCents).toBe(2_500);

    const failing = await failingChannelsSince(wsId, since);
    expect(failing).toContain("social");

    const conv = await conversionsByChannelSince(wsId, since);
    expect(conv.find((c) => c.channel === "ads")).toMatchObject({
      conversions: 5,
      verified: true,
    });
  });
});

describe("suppression list (AC2)", () => {
  it("adds (normalized + idempotent) and loads the suppression set", async () => {
    await addSuppression({ workspaceId: wsId, recipient: "Bad@X.com", reason: "bounce" });
    await addSuppression({ workspaceId: wsId, recipient: "bad@x.com", reason: "complaint" }); // upsert
    const set = await dbSuppressionStore.loadSuppressed(wsId);
    expect(set.has("bad@x.com")).toBe(true);
    expect(set.size).toBe(1); // upsert, not stacked
  });
});

describe("email warmup state", () => {
  it("reports today's sent count and a warmup day", async () => {
    await dbReceiptStore.record({
      workspaceId: wsId,
      ideaId: null,
      channel: "email",
      kind: "email.send",
      provider: "dryrun",
      status: "sent",
      externalId: "dryrun:e1",
      amountCents: null,
      recipientCount: 3,
      detail: {},
    });
    const state = await emailWarmupState(wsId, Date.now());
    expect(state.sentToday).toBe(3);
    expect(state.dayIndex).toBeGreaterThanOrEqual(0);
  });
});
