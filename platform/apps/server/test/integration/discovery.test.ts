import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

const app: FastifyInstance = buildApp();
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

/** Sign up a human in a fresh workspace; return its id + the rid cookie. */
async function seed(): Promise<{ workspaceId: string; cookie: string }> {
  const slug = `disc-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { workspaceId: me.workspaceId, cookie };
}

describe("customer discovery engine (real Postgres): signal → PQL → ranked queue → GTM pipeline → console", () => {
  it(
    "ingests real signals, emits a PQL on an owner-defined signal, ranks a non-empty queue, models the " +
      "5-stage pipeline, lights up founder-console growth, and isolates tenants",
    async () => {
      const w = await seed();
      const other = await seed(); // a sibling workspace — must see none of w's prospects (isolation)
      const post = (url: string, payload: unknown) =>
        app.inject({ method: "POST", url, cookies: { rid: w.cookie }, payload });
      const get = (url: string, cookie = w.cookie) =>
        app.inject({ method: "GET", url, cookies: { rid: cookie } });

      // (1) the owner DEFINES what "product-qualified" means: a power user (>= 5 usage) + pricing intent.
      const power = await post(`/workspaces/${w.workspaceId}/discovery/signal-defs`, {
        kind: "power_user_threshold",
        label: "power user",
        threshold: 5,
        weight: 60,
      });
      expect(power.statusCode).toBe(201);
      await post(`/workspaces/${w.workspaceId}/discovery/signal-defs`, {
        kind: "pricing_page_visit",
        label: "pricing intent",
        threshold: 1,
        weight: 80,
      });
      // a bad def kind → 400.
      const badDef = await post(`/workspaces/${w.workspaceId}/discovery/signal-defs`, {
        kind: "nonsense",
        label: "x",
      });
      expect(badDef.statusCode).toBe(400);

      // (2) ingest REAL product receipts. The first two (2 + 2) stay under the power-user threshold.
      const ingest = (payload: unknown) =>
        post(`/workspaces/${w.workspaceId}/discovery/signals`, payload);
      const i1 = await ingest({ prospectKey: "vp-eng-1", kind: "usage_event", value: 2 });
      expect(i1.statusCode).toBe(201);
      expect(i1.json().pqls).toHaveLength(0);
      await ingest({ prospectKey: "vp-eng-1", kind: "usage_event", value: 2 });

      // the third usage event crosses 5 → a PQL fires on the owner-defined power-user signal.
      const crossing = await ingest({ prospectKey: "vp-eng-1", kind: "usage_event", value: 2 });
      expect(crossing.json().pqls.length).toBeGreaterThanOrEqual(1);
      expect(crossing.json().pqls[0].defKind).toBe("power_user_threshold");
      expect(crossing.json().pqls[0].score).toBeGreaterThan(0);
      expect(crossing.json().pqls[0].verified).toBe(false); // UNVERIFIED — a prediction

      // pricing-page intent qualifies the prospect on a SECOND definition.
      await ingest({ prospectKey: "vp-eng-1", kind: "pricing_page_visit" });
      // a low-signal prospect that never crosses a threshold (stays out of the queue).
      await ingest({ prospectKey: "tire-kicker", kind: "usage_event", value: 1 });
      // a PII-looking prospect key is refused (no PII in the signal store).
      const pii = await ingest({ prospectKey: "alice@example.com", kind: "usage_event" });
      expect(pii.statusCode).toBe(400);

      // (3) the PQL event stream (the seam #223/#225 consume).
      const pqlEvents = (await get(`/workspaces/${w.workspaceId}/discovery/pql-events`)).json();
      expect(pqlEvents.length).toBeGreaterThanOrEqual(1);
      expect(pqlEvents.some((e: { prospectKey: string }) => e.prospectKey === "vp-eng-1")).toBe(true);

      // (4) the daily ranked discovery queue (AC1/AC3): non-empty, top row carries its qualifying signal
      // + an UNVERIFIED likelihood score; the tire-kicker (no match) is absent.
      const queue = (await get(`/workspaces/${w.workspaceId}/discovery/queue?limit=10`)).json();
      expect(queue.unverified).toBe(true);
      expect(queue.prospects.length).toBeGreaterThan(0);
      const top = queue.prospects[0];
      expect(top.prospectKey).toBe("vp-eng-1");
      expect(top.likelihoodLabel).toBe("UNVERIFIED");
      expect(top.scoreVerified).toBe(false);
      expect(top.qualifyingDefs.length).toBeGreaterThanOrEqual(1);
      expect(top.qualifyingSignalKinds).toContain("usage_event");
      expect(
        queue.prospects.some((p: { prospectKey: string }) => p.prospectKey === "tire-kicker"),
      ).toBe(false);

      // (5) an externally-grounded conversion advances the GTM pipeline + is the one VERIFIED stage entry.
      await ingest({ prospectKey: "vp-eng-1", kind: "conversion", externalRef: "evt_stripe_42" });
      const pipeline = (await get(`/workspaces/${w.workspaceId}/discovery/pipeline`)).json();
      expect(pipeline.pqlCount).toBeGreaterThan(0);
      expect(pipeline.metrics.stages.map((s: { stage: string }) => s.stage)).toEqual([
        "outreach",
        "discovery",
        "conversion",
        "onboarding",
        "post_sales",
      ]);
      const stage = (name: string) =>
        pipeline.metrics.stages.find((s: { stage: string }) => s.stage === name);
      expect(stage("outreach").prospects).toBeGreaterThan(0);
      expect(stage("conversion").prospects).toBe(1);
      expect(stage("conversion").verifiedProspects).toBe(1);

      // (#612) closed-out prospects must carry outcome + reason, and reasons roll up into trends.
      const outcomeUrl = "/workspaces/" + w.workspaceId + "/discovery/outcomes";
      const won = await post(outcomeUrl, {
        prospectKey: "vp-eng-1",
        outcome: "won",
        reason: "security proof landed",
        source: "sales-call",
        externalRef: "evt_stripe_42",
      });
      expect(won.statusCode).toBe(201);
      const lost = await post(outcomeUrl, {
        prospectKey: "tire-kicker",
        outcome: "lost",
        reason: "budget freeze",
        source: "sales-call",
      });
      expect(lost.statusCode).toBe(201);
      const missingReason = await post(outcomeUrl, {
        prospectKey: "no-reason",
        outcome: "lost",
        reason: " ",
      });
      expect(missingReason.statusCode).toBe(400);
      const trends = (await get(outcomeUrl + "/trends")).json();
      expect(trends.totalClosed).toBe(2);
      expect(trends.byOutcome.find((r: { outcome: string }) => r.outcome === "won").count).toBe(1);
      expect(trends.byOutcome.find((r: { outcome: string }) => r.outcome === "lost").count).toBe(1);
      expect(trends.byReason).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ outcome: "lost", reason: "budget freeze", count: 1 }),
          expect.objectContaining({ outcome: "won", reason: "security proof landed", count: 1 }),
        ]),
      );

      // (6) AC2 — the founder-console growth panel now reads NON-ZERO, event-driven counts (not
      // placeholders): a first-seen prospect → acquisition, a PQL → activation, a verified conversion →
      // conversion. The discovery pipeline pane mirrors the per-stage counts.
      const fc = (await get(`/workspaces/${w.workspaceId}/founder-console`)).json();
      expect(fc.growth.acquisition).toBeGreaterThan(0);
      expect(fc.growth.activation).toBeGreaterThan(0);
      expect(fc.growth.conversion).toBeGreaterThan(0);
      expect(fc.growth.totalEvents).toBeGreaterThan(0);
      expect(fc.discoveryPipeline.pqlCount).toBeGreaterThan(0);
      expect(
        fc.discoveryPipeline.stages.find((s: { stage: string }) => s.stage === "outreach").prospects,
      ).toBeGreaterThan(0);

      // (7) tenant isolation: the sibling workspace recorded nothing → empty queue + zeroed pipeline, and
      // never saw w's prospects.
      const otherQueue = (
        await get(`/workspaces/${other.workspaceId}/discovery/queue`, other.cookie)
      ).json();
      expect(otherQueue.prospects).toHaveLength(0);
      const otherPipeline = (
        await get(`/workspaces/${other.workspaceId}/discovery/pipeline`, other.cookie)
      ).json();
      expect(otherPipeline.pqlCount).toBe(0);
      expect(otherPipeline.metrics.totalProspects).toBe(0);
    },
  );
});
