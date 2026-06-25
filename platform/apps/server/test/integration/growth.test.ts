import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces, growthEvents, approvalRequests } from "../../src/db/schema/index.js";
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
  const slug = `gr-${newId()}`;
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

async function record(
  workspaceId: string,
  cookie: string,
  kind: string,
  source: string,
  value: number,
): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/growth/events`,
    cookies: { rid: cookie },
    payload: { kind, source, value },
  });
  expect(res.statusCode).toBe(201);
}

describe("growth loop (real Postgres): instrument → score → experiment → #13-gated external post", () => {
  it(
    "aggregates the funnel + score over the route, proposes an experiment, gates the external post, " +
      "and isolates tenants",
    async () => {
      const w = await seed();
      const other = await seed(); // a sibling workspace — must see none of w's growth (isolation)

      // (1) instrument a funnel: 100 acquisitions (80 producthunt / 20 organic), 40 activations,
      // 10 conversions, 20 retentions. The kind taxonomy is validated (a bad kind → 400).
      await record(w.workspaceId, w.cookie, "acquisition", "producthunt", 80);
      await record(w.workspaceId, w.cookie, "acquisition", "organic", 20);
      await record(w.workspaceId, w.cookie, "activation", "", 40);
      await record(w.workspaceId, w.cookie, "conversion", "producthunt", 4);
      await record(w.workspaceId, w.cookie, "conversion", "organic", 6);
      await record(w.workspaceId, w.cookie, "retention", "", 20);

      const bad = await app.inject({
        method: "POST",
        url: `/workspaces/${w.workspaceId}/growth/events`,
        cookies: { rid: w.cookie },
        payload: { kind: "pageview" },
      });
      expect(bad.statusCode).toBe(400);

      // (2) the summary: funnel sums, rates, a 0–100 score, the #96 0–10 signal, top source, and the
      // weakest-stage-first "next 3" experiments.
      const summary = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${w.workspaceId}/growth`,
          cookies: { rid: w.cookie },
        })
      ).json();
      // #901: signup itself is the first acquisition, so the manually-recorded 100 sits on top of it.
      expect(summary.funnel).toEqual({ acquisition: 101, activation: 40, conversion: 10, retention: 20 });
      // activationRate 40/101 (*.4) + conversionRate .25 (*.35) + retentionRate .5 (*.25) ≈ .3709
      expect(summary.score).toBeCloseTo(37.09, 1);
      expect(summary.ventureSignal).toBeCloseTo(3.709, 2);
      expect(summary.topSources[0]).toEqual({ source: "producthunt", value: 80 });
      expect(summary.sourceMetrics).toEqual([
        expect.objectContaining({ source: "producthunt", acquisition: 80, conversion: 4, conversionRate: 0.05 }),
        expect.objectContaining({ source: "organic", acquisition: 20, conversion: 6, conversionRate: 0.3 }),
        expect.objectContaining({ source: "(unattributed)", acquisition: 1, activation: 40, retention: 20 }),
      ]);
      expect(summary.recommendations).toHaveLength(3);
      // conversionRate (.25) is the weakest stage → first recommendation.
      expect(summary.recommendations[0].stage).toBe("conversion");

      // (3) a marketing agent proposes a channel experiment.
      const proposed = await app.inject({
        method: "POST",
        url: `/workspaces/${w.workspaceId}/growth/experiments`,
        cookies: { rid: w.cookie },
        payload: {
          channel: "producthunt",
          hypothesis: "Launch lifts conversion",
          targetQuery: "ai agent platform",
          targetSource: "producthunt",
        },
      });
      expect(proposed.statusCode).toBe(201);
      const experimentId = proposed.json().id;
      expect(proposed.json().status).toBe("proposed");
      expect(proposed.json().targetSource).toBe("producthunt");

      // (4) promote it to an external post → a PENDING #13 approval is created (gated, NOT executed);
      // an agent never publishes autonomously. The route answers 202 with the gated request id.
      const post = await app.inject({
        method: "POST",
        url: `/workspaces/${w.workspaceId}/growth/experiments/${experimentId}/external-post`,
        cookies: { rid: w.cookie },
        payload: { kind: "social.post", summary: "Launching on Product Hunt today 🚀", target: "@reload" },
      });
      expect(post.statusCode).toBe(202);
      const approvalRequestId = post.json().approvalRequestId;
      expect(approvalRequestId).toBeTruthy();
      expect(post.json().experiment.approvalRequestId).toBe(approvalRequestId);

      const [approval] = await db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.workspaceId, w.workspaceId),
            eq(approvalRequests.id, approvalRequestId),
          ),
        );
      expect(approval.actionType).toBe("external.send"); // rides the existing gate, sensitive-by-default
      expect(approval.status).toBe("pending"); // a human must approve + post — never auto-executed

      // a missing experiment → 404.
      const missing = await app.inject({
        method: "POST",
        url: `/workspaces/${w.workspaceId}/growth/experiments/${newId()}/external-post`,
        cookies: { rid: w.cookie },
        payload: { kind: "social.post", summary: "x" },
      });
      expect(missing.statusCode).toBe(404);

      // (5) the Founder Console growth pane reflects the funnel + score + experiment pipeline.
      const console = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${w.workspaceId}/founder-console`,
          cookies: { rid: w.cookie },
        })
      ).json();
      expect(console.growth.totalEvents).toBe(7);
      expect(console.growth.acquisition).toBe(101);
      expect(console.growth.score).toBeCloseTo(37.09, 1);
      expect(console.growth.topSource).toBe("producthunt");
      expect(console.growth.experimentsTotal).toBe(1);
      expect(console.growth.externalPostsSubmitted).toBe(1);

      // (6) tenant isolation: the sibling workspace sees only its own signup acquisition and never w's events.
      const otherSummary = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${other.workspaceId}/growth`,
          cookies: { rid: other.cookie },
        })
      ).json();
      expect(otherSummary.funnel).toEqual({ acquisition: 1, activation: 0, conversion: 0, retention: 0 });
      expect(otherSummary.score).toBe(0);
      const otherEvents = await db
        .select()
        .from(growthEvents)
        .where(eq(growthEvents.workspaceId, other.workspaceId));
      expect(otherEvents).toHaveLength(1);
    },
  );
});
