import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces, acquisitionSendReceipts } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

// #200 / #337 — the single, pure predicate for "is this proof production-grounded?".
import { isExternalReceipt, type ExternalReceipt } from "../../src/action-contract/receipt.js";

// Hop 1 — outbound send (acquisition send receipt rows + the external-grounded read models).
import {
  dbReceiptStore,
  sentCountByChannelSince,
  conversionsByChannelSince,
} from "../../src/db/repositories/acquisition.js";

// Hop 2 — landing / attribution (mint a tracking ref, record the exposure, recover it on the visit).
import { mintTrackingRef, buildTrackedUrl, recoverTrackingRef } from "../../src/attribution/tracking.js";
import { dbAttributionExposureStore } from "../../src/db/repositories/attribution.js";
import {
  recordLiveShipExposure,
  projectAttributedRevenue,
  type AttributionServiceDeps,
} from "../../src/attribution/service.js";

// Hop 3 — signup (a stranger hand-raises on the landing form; the ref rides along to attribution).
import { sanitizeLead } from "../../src/leads/inbound.js";
import { recordLead, listLeads } from "../../src/db/repositories/inbound-leads.js";

// Hop 4 — checkout via Stripe TEST MODE (none provider = zero network/zero spend; signed webhook).
import { BillingManager } from "../../src/billing/manager.js";
import { NoneBillingProvider } from "../../src/billing/none-provider.js";
import { signWebhookPayload } from "../../src/billing/webhook.js";
import { billingStatus, assertKeyMatchesMode, stripeKeyMode } from "../../src/billing/mode.js";
import { dbBillingStore } from "../../src/db/repositories/billing.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { CONFIG_DEFAULTS, type ResolvedConfig } from "../../src/config/schema.js";
import type { ChannelPoster } from "../../src/runtime/manager.js";

// Hop 5 — recorded conversion (the production revenue reader the attribution route uses).
import { dbRevenueReader } from "../../src/finance/default.js";

/**
 * #562 — END-TO-END CONVERSION SMOKE TEST (stranger → site → signup → paying customer).
 *
 * This is the one path the business is defined by, and the only test that walks ALL of it against a real
 * Postgres (the integration job's service container; safe to run nightly — see the
 * `conversion-smoke-nightly` workflow). The funnel pieces are independent subsystems joined by a single
 * **tracking ref** (#386) and Stripe checkout metadata; this test threads ONE ref through every hop:
 *
 *   outbound send  →  landing/attribution  →  signup  →  checkout (Stripe TEST MODE)  →  recorded conversion
 *
 * Each hop must emit an **observation receipt** — the #200/#337 contract: a success claim may only rest on
 * something the system observed touching reality (a `production_readback`: a real row/event id read back
 * out of Postgres), never a self-report. So at every hop we DRIVE the seam, READ THE RESULT BACK out of
 * the database, and build an {@link ExternalReceipt} whose `externalRef` is that read-back value. If a hop
 * is broken — it wrote nothing, so there is nothing to read back — {@link readbackReceipt} throws a
 * {@link ReceiptGapError} naming THAT hop, so a regression fails AT the broken hop with a clear gap rather
 * than silently downstream (the issue's acceptance criterion).
 *
 * Money safety: the checkout hop uses the {@link NoneBillingProvider} (no network, no real charge) and a
 * webhook secret supplied ONLY via env (`STRIPE_WEBHOOK_SECRET`), falling back to a non-secret test value —
 * no key is ever committed. A real Stripe key may be injected via env for a staging run, but it MUST be a
 * `*_test_*` key (asserted below); `billingStatus(...).live` is asserted false so this can never move real
 * money. The live checkout-link mint path is covered by `billing.test.ts` (#98); this smoke proves the
 * funnel JOIN — the dollar attributing back to the channel that produced it.
 */

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const AMOUNT_CENTS = 2500;

// Test-mode only. The webhook secret comes from env (never committed); a non-secret default keeps CI
// hermetic. If a real Stripe secret key is supplied via env, it must be a test-mode key — fail closed.
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_conversion_smoke_test_secret";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";

/** The five funnel hops, in order — the receipt for each is collected and asserted. */
const HOPS = [
  "outbound_send",
  "landing_attribution",
  "signup",
  "checkout_stripe_test",
  "recorded_conversion",
] as const;
type Hop = (typeof HOPS)[number];

/** A funnel hop that emitted no production-grounded receipt — the funnel is broken HERE, not downstream. */
class ReceiptGapError extends Error {
  constructor(
    readonly hop: Hop,
    readonly externalRef: unknown,
  ) {
    super(
      `RECEIPT GAP at hop "${hop}": no production-grounded receipt (externalRef=${JSON.stringify(
        externalRef,
      )}). This hop did not emit an observation receipt read back from Postgres — the conversion funnel ` +
        `is broken at this hop.`,
    );
    this.name = "ReceiptGapError";
  }
}

/**
 * Build the #200 `production_readback` receipt for a hop from a value READ BACK out of Postgres. Throws a
 * {@link ReceiptGapError} naming the hop when the read-back reference is missing/blank — so a broken hop
 * fails AT that hop. `observedAt` is the wall-clock at which we read reality back (the contract never
 * reads a clock itself).
 */
function readbackReceipt(
  hop: Hop,
  externalRef: string | null | undefined,
  detail: Record<string, unknown> = {},
): ExternalReceipt {
  const candidate: ExternalReceipt = {
    source: "production_readback",
    externalRef: typeof externalRef === "string" ? externalRef : "",
    observedAt: new Date().toISOString(),
    detail: { hop, ...detail },
  };
  if (!isExternalReceipt(candidate)) throw new ReceiptGapError(hop, externalRef);
  return candidate;
}

const wsId = newId();
const slug = `conv-smoke-${Date.now()}`;
// A lower bound for the "since" read models — comfortably before any row this test writes.
const since = new Date(Date.now() - 5 * 60_000);
// The exposure happened-before the payment by construction, so it earns credit regardless of any small
// app/DB clock skew in CI (the projection credits an exposure only if it preceded the receipt).
const exposureAtMs = Date.now() - 60_000;

/** Silent poster — the webhook path posts to a channel only when metadata carries one; ours does not. */
const silentPoster: ChannelPoster = { post: async () => ({ id: "" }) };
const loadConfig = (): ResolvedConfig => ({
  ...CONFIG_DEFAULTS,
  billing: { provider: "none", currency: "usd" },
});

beforeAll(async () => {
  await db.insert(workspaces).values({ id: wsId, slug, name: "Conversion Smoke" });
});

afterAll(async () => {
  // Workspace delete cascades the funnel rows (send receipts, exposures, leads, revenue events).
  await db.delete(workspaces).where(eq(workspaces.id, wsId));
  await closeDb();
  await closeRedis();
});

describe("#562 conversion smoke: stranger → site → signup → paying customer", () => {
  it("walks the full funnel and emits a production-readback receipt at every hop", async () => {
    const receipts: ExternalReceipt[] = [];

    // Money-safety preflight: this configuration can never charge a real card, and any env-supplied key
    // must be test-mode (never live).
    expect(billingStatus("none", "test").live).toBe(false);
    if (STRIPE_SECRET_KEY && stripeKeyMode(STRIPE_SECRET_KEY) !== "unknown") {
      expect(() => assertKeyMatchesMode("test", STRIPE_SECRET_KEY)).not.toThrow();
    }

    // ── Hop 1: outbound send ──────────────────────────────────────────────────────────────────────
    // The fleet publishes an SEO artifact through the acquisition dispatcher (dryrun provider = the send
    // is recorded with an external_id but no network). The receipt row IS the send's observation.
    const artifactUrl = `https://ipop.ai/blog/conversion-smoke-${newId()}`;
    await dbReceiptStore.record({
      workspaceId: wsId,
      ideaId: null,
      channel: "seo",
      kind: "seo_publish",
      provider: "dryrun",
      status: "sent",
      externalId: artifactUrl,
      amountCents: 0,
      recipientCount: 1,
      detail: { smoke: "conversion", artifactUrl },
    });
    const sentCount = await sentCountByChannelSince(wsId, "seo", since);
    expect(sentCount).toBeGreaterThanOrEqual(1);
    // Read the external_id back out of Postgres — the production-grounded reference of what shipped.
    const [sentRow] = await db
      .select({ externalId: acquisitionSendReceipts.externalId })
      .from(acquisitionSendReceipts)
      .where(
        and(
          eq(acquisitionSendReceipts.workspaceId, wsId),
          eq(acquisitionSendReceipts.channel, "seo"),
          eq(acquisitionSendReceipts.status, "sent"),
        ),
      )
      .limit(1);
    expect(sentRow?.externalId).toBe(artifactUrl);
    receipts.push(readbackReceipt("outbound_send", sentRow?.externalId, { channel: "seo", sentCount }));

    // ── Hop 2: landing / attribution ──────────────────────────────────────────────────────────────
    // Record the exposure (the artifact went live) and mint the stable tracking ref it carries. Then
    // simulate the stranger's inbound visit and recover the ref from the landing URL.
    const attrDeps: AttributionServiceDeps = {
      store: dbAttributionExposureStore,
      revenue: dbRevenueReader,
      maxChainAgeMs: THIRTY_DAYS_MS,
      now: () => exposureAtMs,
    };
    const ref = await recordLiveShipExposure(attrDeps, {
      workspaceId: wsId,
      externalRef: artifactUrl,
      channel: "seo",
      artifactKind: "seo_page",
    });
    expect(ref).toBe(mintTrackingRef({ workspaceId: wsId, artifactId: artifactUrl, channel: "seo" }));
    const landedUrl = buildTrackedUrl(artifactUrl, ref, {
      source: "seo",
      medium: "organic",
      campaign: "conversion-smoke",
    });
    expect(recoverTrackingRef(landedUrl)).toBe(ref); // the visit recovers our ref
    // Read the exposure back out of Postgres for (workspace, ref).
    const exposures = await dbAttributionExposureStore.listExposures(wsId);
    const exposure = exposures.find((e) => e.trackingRef === ref);
    expect(exposure?.artifactId).toBe(artifactUrl);
    receipts.push(
      readbackReceipt("landing_attribution", exposure?.trackingRef, {
        channel: exposure?.channel,
        artifactId: exposure?.artifactId,
        recoveredFrom: landedUrl,
      }),
    );

    // ── Hop 3: signup ───────────────────────────────────────────────────────────────────────────────
    // The stranger raises a hand on the landing form. The free-text body is UNTRUSTED (#200 §6) — sanitize
    // it, then persist. The tracking ref survives sanitization and ties the signup back to the exposure.
    const sani = sanitizeLead({
      email: `stranger-${newId()}@example.com`,
      message: "I want the fleet to run my growth.",
      source: "landing_form",
      trackingRef: ref,
    });
    expect(sani.ok).toBe(true);
    if (!sani.ok) throw new Error(`signup hop: lead failed sanitization: ${sani.error}`);
    expect(sani.lead.trackingRef).toBe(ref);
    const { id: leadId } = await recordLead({
      workspaceId: wsId,
      name: sani.lead.name,
      email: sani.lead.email,
      message: sani.lead.message,
      source: sani.lead.source,
      trackingRef: sani.lead.trackingRef,
    });
    const lead = (await listLeads(wsId)).find((l) => l.id === leadId);
    expect(lead?.trackingRef).toBe(ref); // signup attributed to the originating exposure
    receipts.push(
      readbackReceipt("signup", lead?.id, { trackingRef: lead?.trackingRef, source: lead?.source }),
    );

    // ── Hop 4: checkout via Stripe TEST MODE ────────────────────────────────────────────────────────
    // A signature-verified `checkout.session.completed` from Stripe test mode, carrying the tracking ref in
    // checkout metadata. The none provider means no real charge; the BillingManager verifies, dedupes, and
    // writes the revenue_events row. The Stripe event id read back IS the canonical production receipt.
    const billing = new BillingManager({
      provider: new NoneBillingProvider(),
      store: dbBillingStore,
      poster: silentPoster,
      secrets: new StaticSecretsResolver({
        STRIPE_SECRET_KEY: STRIPE_SECRET_KEY || "sk_test_conversion_smoke",
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      }),
      deployments: { latestForSession: async () => undefined },
      loadConfig,
    });
    const stripeEventId = `evt_${newId()}`;
    const rawEvent = JSON.stringify({
      id: stripeEventId,
      type: "checkout.session.completed",
      data: {
        object: {
          amount_total: AMOUNT_CENTS,
          currency: "usd",
          status: "complete",
          payment_status: "paid",
          metadata: { trackingRef: ref },
        },
      },
    });
    const sig = signWebhookPayload(rawEvent, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
    const ingest = await billing.ingestWebhook(wsId, rawEvent, sig);
    expect(ingest.deduped).toBe(false);
    expect(ingest.event?.providerEventId).toBe(stripeEventId);
    // Read the revenue event back via the SAME reader the attribution projection uses (the BillingStore's
    // own read model intentionally omits the ref): the tracking ref round-tripped through Stripe metadata
    // onto the revenue_events row, so the payment can be attributed to the artifact that drove it.
    const paidReceipt = (await dbRevenueReader.listReceipts(wsId)).find(
      (r) => r.providerEventId === stripeEventId,
    );
    expect(paidReceipt?.trackingRef).toBe(ref);
    // Read revenue back out of Postgres.
    const revenue = await billing.revenue(wsId);
    expect(revenue.totalCents).toBe(AMOUNT_CENTS);
    expect(revenue.paymentCount).toBe(1);
    expect(revenue.evidenceCount).toBe(1); // willingness-to-pay evidence recorded
    // A replayed delivery (same event id) is idempotent — nightly re-runs never double-count.
    const replay = await billing.ingestWebhook(wsId, rawEvent, sig);
    expect(replay.deduped).toBe(true);
    expect((await billing.revenue(wsId)).paymentCount).toBe(1);
    receipts.push(
      readbackReceipt("checkout_stripe_test", ingest.event?.providerEventId, {
        amountCents: revenue.totalCents,
        provider: "none",
        mode: "test",
      }),
    );

    // ── Hop 5: recorded conversion ──────────────────────────────────────────────────────────────────
    // The payoff: project attributed revenue over the real revenue reader and the recorded exposure. The
    // dollar is credited back, by happened-before causality, to the SEO artifact/channel that produced it.
    const projection = await projectAttributedRevenue(
      { ...attrDeps, now: () => Date.now() },
      wsId,
    );
    const credited = projection.attributed.find((e) => e.trackingRef === ref);
    expect(credited, "conversion not attributed back to the originating exposure").toBeDefined();
    expect(credited!.channel).toBe("seo"); // tied back to the outbound channel
    expect(credited!.artifactId).toBe(artifactUrl);
    expect(credited!.amountCents).toBe(AMOUNT_CENTS);
    expect(credited!.providerEventId).toBe(stripeEventId);
    expect(projection.byArtifact.some((a) => a.artifactId === artifactUrl && a.channel === "seo")).toBe(
      true,
    );

    // Record the verified conversion back onto the channel's CAC ledger — verified ONLY because it is
    // grounded by the external Stripe event id (#200 §2: a self-reported count is never `verified`).
    await dbReceiptStore.record({
      workspaceId: wsId,
      ideaId: null,
      channel: "seo",
      kind: "conversion",
      provider: "stripe",
      status: "sent",
      externalId: stripeEventId,
      amountCents: 0,
      recipientCount: 0,
      detail: { conversions: 1, conversionsVerified: true, providerEventId: stripeEventId },
    });
    const seoConversions = (await conversionsByChannelSince(wsId, since)).find((c) => c.channel === "seo");
    expect(seoConversions?.conversions).toBe(1);
    expect(seoConversions?.verified).toBe(true);
    receipts.push(
      readbackReceipt("recorded_conversion", credited!.providerEventId, {
        channel: credited!.channel,
        artifactId: credited!.artifactId,
        amountCents: credited!.amountCents,
      }),
    );

    // Every hop emitted a valid #200 production-grounded receipt, in order — the funnel is whole.
    expect(receipts.map((r) => (r.detail as { hop: Hop }).hop)).toEqual([...HOPS]);
    for (const r of receipts) expect(isExternalReceipt(r)).toBe(true);
  });

  it("fails AT the broken hop with a clear receipt gap when a hop emits nothing", () => {
    // The contract guard the funnel walk relies on: a hop with no read-back reference throws a gap error
    // naming THAT hop (here: signup), never a vague downstream failure.
    expect(() => readbackReceipt("signup", undefined)).toThrowError(ReceiptGapError);
    expect(() => readbackReceipt("signup", "")).toThrowError(/RECEIPT GAP at hop "signup"/);
    // A fabricated, non-production receipt is rejected by the #200 predicate (never marks success).
    expect(isExternalReceipt({ source: "self_report", externalRef: "x", observedAt: "now" })).toBe(false);
  });
});
