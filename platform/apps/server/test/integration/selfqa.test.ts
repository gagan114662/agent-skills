import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces, failureFingerprints } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { SelfQaEngine } from "../../src/selfqa/engine.js";
import { SelfQaRunner } from "../../src/selfqa/runner.js";
import { flywheelReporter } from "../../src/selfqa/bridge.js";
import { resolveSelfqaCaps } from "../../src/selfqa/caps.js";
import { listSelfqaRuns, startSelfqaRun, finishSelfqaRun } from "../../src/db/repositories/selfqa.js";
import type { QaBrowserDriver } from "../../src/selfqa/driver.js";

/**
 * Self-QA loop (#171) — the loop tests ITSELF end-to-end against the real DB: a failing synthetic run
 * persists a `selfqa_runs` row AND flows its findings through the #117 flywheel into a `qa_failure`
 * fingerprint row. Proves the 0171 migration + repo + the flywheel bridge wire together for real.
 */

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const app: FastifyInstance = buildApp();
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

/** Sign up a human in a fresh workspace — this IS the (test) synthetic workspace. */
async function seedSyntheticWorkspace(): Promise<string> {
  const slug = `selfqa-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return me.workspaceId as string;
}

/** A driver that fails the two named (critical + high) checks; everything else passes. */
const failing: QaBrowserDriver = {
  run: async (check) =>
    check.id === "sessions-produce-replies" || check.id === "layout-no-overflow"
      ? { checkId: check.id, ok: false, actual: "synthetic failure" }
      : { checkId: check.id, ok: true },
};

describe("self-QA loop end-to-end (#171)", () => {
  it("records a failed run row and files the findings through the #117 flywheel as qa_failure", async () => {
    const workspaceId = await seedSyntheticWorkspace();
    const caps = () => resolveSelfqaCaps({ enabled: true });

    const engine = new SelfQaEngine({
      runner: new SelfQaRunner({ driver: failing, caps, isSyntheticWorkspace: () => true }),
      caps,
      target: "https://ipop.ai",
      resolveSyntheticWorkspaceId: async () => workspaceId,
      reporter: (wid) => flywheelReporter({ workspaceId: wid, record: (e) => app.flywheelEngine.record(e) }),
      persist: { start: (i) => startSelfqaRun(i), finish: (i) => finishSelfqaRun(i) },
      logger: silentLogger,
    });

    const out = await engine.runOnce("smoke");
    expect(out.workspaceId).toBe(workspaceId);
    expect(out.reported).toBe(2);

    // (1) the durable run row
    const runs = await listSelfqaRuns(workspaceId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.checksFailed).toBe(2);
    expect(runs[0]!.criticalCount).toBe(1);
    expect(runs[0]!.finishedAt).not.toBeNull();

    // (2) the findings flowed through the flywheel ledger as qa_failure fingerprints
    const fps = await db
      .select()
      .from(failureFingerprints)
      .where(and(eq(failureFingerprints.workspaceId, workspaceId), eq(failureFingerprints.failureClass, "qa_failure")));
    expect(fps.length).toBe(2);
    const titles = fps.map((f) => f.title).join(" | ");
    expect(titles.toLowerCase()).toContain("self-qa");
  });
});
