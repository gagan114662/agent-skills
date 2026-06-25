import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { closeDb, db } from "../../src/db/index.js";
import { newId } from "../../src/db/id.js";
import { workspaces } from "../../src/db/schema/index.js";
import { closeRedis } from "../../src/redis/index.js";

describe("#590 dependency scheduler routes (real Postgres)", () => {
  let app: FastifyInstance;
  const slugs: string[] = [];
  const previousEnabled = process.env.DEP_SCHEDULER_ENABLED;

  beforeAll(async () => {
    process.env.DEP_SCHEDULER_ENABLED = "1";
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    if (previousEnabled === undefined) delete process.env.DEP_SCHEDULER_ENABLED;
    else process.env.DEP_SCHEDULER_ENABLED = previousEnabled;
    for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
    await app.close();
    await Promise.allSettled([closeDb(), closeRedis()]);
  });

  async function owner() {
    const slug = `dep-sched-${newId()}`;
    slugs.push(slug);
    const signup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Owner", workspaceSlug: slug },
    });
    const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
    const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
    return { cookie, workspaceId: me.workspaceId };
  }

  const post = (w: { workspaceId: string; cookie: string }, path: string, payload?: unknown) =>
    app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/dependency-scheduler${path}`,
      cookies: { rid: w.cookie },
      payload,
    });

  const get = (w: { workspaceId: string; cookie: string }, path: string) =>
    app.inject({
      method: "GET",
      url: `/workspaces/${w.workspaceId}/dependency-scheduler${path}`,
      cookies: { rid: w.cookie },
    });

  it("keeps outbound work unclaimable until its visible upstream gate is approved", async () => {
    const w = await owner();
    const review = (
      await post(w, "/tasks", { kind: "review", label: "review launch post", objectiveId: "launch" })
    ).json();
    const publish = (
      await post(w, "/tasks", {
        kind: "publish",
        label: "publish launch post",
        objectiveId: "launch",
        dependsOn: [review.id],
      })
    ).json();

    expect(publish.dependsOn).toEqual([review.id]);
    const listed = (await get(w, "/tasks")).json();
    expect(listed.find((t: { id: string }) => t.id === publish.id)?.dependsOn).toEqual([review.id]);

    const initialPlan = (await get(w, "/plan?objectiveId=launch")).json();
    expect(initialPlan.runnable).toEqual([review.id]);
    expect(initialPlan.blocked).toContainEqual({
      taskId: publish.id,
      reason: "waiting_on_upstream",
      blockedBy: [review.id],
      permanent: false,
    });

    const c1 = (await post(w, "/claim", { objectiveId: "launch" })).json();
    expect(c1.task.id).toBe(review.id);
    expect((await post(w, "/claim", { objectiveId: "launch" })).json().task).toBeNull();

    await post(w, `/tasks/${review.id}/approve`);
    const c2 = (await post(w, "/claim", { objectiveId: "launch" })).json();
    expect(c2.task.id).toBe(publish.id);
  });

  it("fails closed for an ungated outbound task", async () => {
    const w = await owner();
    const publish = (await post(w, "/tasks", { kind: "publish", label: "ship without gate" })).json();
    const plan = (await get(w, "/plan")).json();
    expect(plan.runnable).not.toContain(publish.id);
    expect(plan.blocked.find((b: { taskId: string }) => b.taskId === publish.id)).toMatchObject({
      reason: "ungated_outbound",
      permanent: true,
    });
    expect((await post(w, "/claim")).json().task).toBeNull();
  });
});
