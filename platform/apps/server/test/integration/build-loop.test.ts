import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces, buildLoopRuns, buildLoopReviews } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import {
  buildLoopRunStore,
  buildLoopReviewStore,
  listActiveBuildLoopWorkspaces,
} from "../../src/db/repositories/build-loop.js";
import {
  BuildLoopEngine,
  type BuildLauncher,
  type Escalator,
  type PrDiff,
  type RepoHost,
  type Reviewer,
} from "../../src/build-loop/engine.js";
import { evaluateHouseRubric } from "../../src/build-loop/rubric.js";
import { issueNumberOf } from "../../src/build-loop/render.js";
import { BUILDLOOP_DEFAULTS, type BuildLoopCaps } from "../../src/build-loop/caps.js";
import { DEFAULT_PROTECTED_PATHS } from "../../src/build-loop/guardrails.js";
import { makeRedactor } from "../../src/runtime/redact.js";
import type { SessionLogger } from "../../src/runtime/manager.js";
import type { ReviewAssessment } from "../../src/build-loop/types.js";

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const app: FastifyInstance = buildApp();
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface World {
  workspaceId: string;
  cookie: string;
  channelId: string;
  agentMemberId: string;
}

/** Sign up a human in a fresh workspace, make a channel, register an agent (the build-launch target). */
async function seed(): Promise<World> {
  const slug = `bl-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  const channel = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/channels`,
    cookies: { rid: cookie },
    payload: { name: "agents" },
  });
  const agent = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/agents`,
    cookies: { rid: cookie },
    payload: { name: "Builder" },
  });
  return {
    workspaceId: me.workspaceId,
    cookie,
    channelId: channel.json().id,
    agentMemberId: agent.json().memberId,
  };
}

/** A programmable repo host: tests arm a PR per issue ref, scripted diffs, CI state, and merges. */
function fakeRepo() {
  const prByIssue = new Map<string, { prRef: string; headBranch: string }>();
  const diffByPr = new Map<string, PrDiff>();
  const ciByPr = new Map<string, boolean>();
  const conflictByPr = new Map<string, boolean>();
  const merges: string[] = [];
  const comments: Array<{ prRef: string; body: string }> = [];
  let seq = 0;
  const host: RepoHost = {
    observePr: async ({ run }) => prByIssue.get(run.issueRef) ?? null,
    getDiff: async ({ prRef }) =>
      diffByPr.get(prRef) ?? { files: [], additions: 0, deletions: 0, addedLines: [] },
    ciGreen: async ({ prRef }) => ciByPr.get(prRef) ?? true,
    comment: async ({ prRef, body }) => {
      comments.push({ prRef, body });
    },
    merge: async ({ prRef }) => {
      merges.push(prRef);
      seq += 1;
      return { mergeRef: `merge:${prRef}:${seq}` };
    },
    updateFromMain: async ({ prRef }) => ({ conflicted: conflictByPr.get(prRef) ?? false }),
  };
  /** Arm a PR for an issue with a diff + CI state (simulates the build agent opening a PR). */
  function openPr(issueRef: string, diff: PrDiff, ciGreen = true): string {
    const prRef = `github:acme/web#${100 + prByIssue.size}`;
    prByIssue.set(issueRef, { prRef, headBranch: `agent/${issueNumberOf(issueRef)}` });
    diffByPr.set(prRef, diff);
    ciByPr.set(prRef, ciGreen);
    return prRef;
  }
  return { host, openPr, diffByPr, ciByPr, conflictByPr, merges, comments, prByIssue };
}

function fakeLauncher() {
  const calls: Array<{ issueRef: string; role: string }> = [];
  const launcher: BuildLauncher = {
    launch: async ({ run, role }) => {
      calls.push({ issueRef: run.issueRef, role });
      return { id: newId() };
    },
  };
  return { launcher, calls };
}

function fakeEscalator() {
  const calls: Array<{ issueRef: string; reason: string; summary: string }> = [];
  const escalator: Escalator = {
    escalate: async ({ run, reason, summary }) => {
      calls.push({ issueRef: run.issueRef, reason, summary });
    },
  };
  return { escalator, calls };
}

/** The default reviewer: the real house rubric over the diff (issue number from the ref). */
const rubricReviewer: Reviewer = {
  review: async ({ run, diff }) =>
    evaluateHouseRubric({
      issueNumber: issueNumberOf(run.issueRef),
      files: diff.files,
      addedLines: diff.addedLines,
      protectedPaths: DEFAULT_PROTECTED_PATHS,
    }),
};

/** A clean, tested, workspace-scoped, correctly-numbered diff that PASSes the rubric. */
function cleanDiff(issueNumber: number): PrDiff {
  return {
    files: [`apps/server/src/build-loop/x.ts`, `apps/server/test/unit/x-${issueNumber}.test.ts`],
    additions: 40,
    deletions: 5,
    addedLines: ["export function ok() { return true; }"],
  };
}

function makeEngine(opts: {
  repo: RepoHost;
  launcher: BuildLauncher;
  escalator: Escalator;
  reviewer?: Reviewer;
  enabled: Set<string>;
  killSwitchOn: Set<string>;
  redact?: (t: string) => string;
  caps?: Partial<BuildLoopCaps>;
}): BuildLoopEngine {
  return new BuildLoopEngine({
    runs: buildLoopRunStore,
    reviews: buildLoopReviewStore,
    repo: opts.repo,
    launcher: opts.launcher,
    reviewer: opts.reviewer ?? rubricReviewer,
    escalator: opts.escalator,
    caps: (wid) =>
      opts.enabled.has(wid)
        ? { ...BUILDLOOP_DEFAULTS, enabled: true, maxConcurrentBuilds: 1, ...opts.caps }
        : { ...BUILDLOOP_DEFAULTS, enabled: false },
    killSwitch: async (wid) => opts.killSwitchOn.has(wid),
    budgetExhausted: async () => false,
    redact: opts.redact ?? ((t) => t),
    activeWorkspaces: listActiveBuildLoopWorkspaces,
    logger: silentLogger,
    now: () => new Date(),
  });
}

describe("self-shipping loop (real Postgres): issue → build → review → merge within guardrails", () => {
  it("rejects cross-workspace dispatch targets before persisting a build-loop run", async () => {
    const w = await seed();
    const other = await seed();

    const crossChannel = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/build-loop/issues`,
      cookies: { rid: w.cookie },
      payload: {
        issueRef: "github:acme/web#9821",
        issueTitle: "Cross-tenant channel",
        agentOk: true,
        targetChannelId: other.channelId,
        targetAgentMemberId: w.agentMemberId,
      },
    });
    expect(crossChannel.statusCode).toBe(404);

    const crossAgent = await app.inject({
      method: "POST",
      url: `/workspaces/${w.workspaceId}/build-loop/issues`,
      cookies: { rid: w.cookie },
      payload: {
        issueRef: "github:acme/web#9822",
        issueTitle: "Cross-tenant agent",
        agentOk: true,
        targetChannelId: w.channelId,
        targetAgentMemberId: other.agentMemberId,
      },
    });
    expect(crossAgent.statusCode).toBe(404);

    expect(await buildLoopRunStore.getByIssueRef(w.workspaceId, "github:acme/web#9821")).toBeNull();
    expect(await buildLoopRunStore.getByIssueRef(w.workspaceId, "github:acme/web#9822")).toBeNull();
  });

  it(
    "dedups an issue, dispatches under the concurrency cap, auto-merges a clean PR, skips on the kill " +
      "switch, and never touches a disabled workspace",
    async () => {
      const w = await seed();
      const wDisabled = await seed(); // loop disabled here — must stay untouched (isolation)

      const repo = fakeRepo();
      const launcher = fakeLauncher();
      const escalator = fakeEscalator();
      const enabled = new Set([w.workspaceId]);
      const killSwitchOn = new Set<string>();
      const engine = makeEngine({ repo: repo.host, launcher: launcher.launcher, escalator: escalator.escalator, enabled, killSwitchOn });

      // (1) record two agent-ok issues (#1 higher priority) + one NOT agent-ok; dedup #1 on re-record.
      await engine.recordIssue(w.workspaceId, {
        issueRef: "github:acme/web#1",
        issueTitle: "Feature one",
        priority: 10,
        agentOk: true,
        targetChannelId: w.channelId,
        targetAgentMemberId: w.agentMemberId,
      });
      await engine.recordIssue(w.workspaceId, {
        issueRef: "github:acme/web#1", // dedup — same ref
        issueTitle: "Feature one",
        priority: 10,
        agentOk: true,
        targetChannelId: w.channelId,
        targetAgentMemberId: w.agentMemberId,
      });
      await engine.recordIssue(w.workspaceId, {
        issueRef: "github:acme/web#3",
        issueTitle: "Feature three",
        priority: 5,
        agentOk: true,
        targetChannelId: w.channelId,
        targetAgentMemberId: w.agentMemberId,
      });
      await engine.recordIssue(w.workspaceId, {
        issueRef: "github:acme/web#2",
        issueTitle: "Not approved",
        priority: 99,
        agentOk: false, // never auto-built despite the highest priority
        targetChannelId: w.channelId,
        targetAgentMemberId: w.agentMemberId,
      });
      const rows = await db.select().from(buildLoopRuns).where(eq(buildLoopRuns.workspaceId, w.workspaceId));
      expect(rows).toHaveLength(3); // dedup: #1 is a single row

      // (2) kill switch → the whole tick is skipped (no dispatch).
      killSwitchOn.add(w.workspaceId);
      expect((await engine.tickWorkspace(w.workspaceId, new Date())).skipped).toBe("kill_switch");
      expect(launcher.calls).toHaveLength(0);
      killSwitchOn.delete(w.workspaceId);

      // (3) tick → ONE build dispatched (cap=1), the highest-priority AGENT-OK issue (#1), not #2.
      await engine.tickWorkspace(w.workspaceId, new Date());
      expect(launcher.calls).toEqual([{ issueRef: "github:acme/web#1", role: "build" }]);
      expect((await buildLoopRunStore.getByIssueRef(w.workspaceId, "github:acme/web#1"))?.status).toBe("building");

      // (4) the build agent opens a clean PR; next tick advances building → reviewing (no new dispatch — cap).
      repo.openPr("github:acme/web#1", cleanDiff(1));
      await engine.tickWorkspace(w.workspaceId, new Date());
      const reviewing = await buildLoopRunStore.getByIssueRef(w.workspaceId, "github:acme/web#1");
      expect(reviewing?.status).toBe("reviewing");
      expect(reviewing?.prRef).toBeTruthy();
      expect(launcher.calls).toHaveLength(1); // still capped

      // (5) next tick → reviewer PASSes, all guardrails hold → AUTO-MERGE. Capacity frees → #3 dispatched.
      await engine.tickWorkspace(w.workspaceId, new Date());
      const merged = await buildLoopRunStore.getByIssueRef(w.workspaceId, "github:acme/web#1");
      expect(merged?.status).toBe("merged");
      expect(merged?.mergeRef).toBeTruthy();
      expect(repo.merges).toHaveLength(1);
      expect(launcher.calls.map((c) => c.issueRef)).toContain("github:acme/web#3"); // freed capacity
      // a verdict comment was posted + a review row persisted.
      const reviews = await db.select().from(buildLoopReviews).where(eq(buildLoopReviews.workspaceId, w.workspaceId));
      expect(reviews.length).toBeGreaterThanOrEqual(1);
      expect(reviews[0].verdict).toBe("pass");
      expect(escalator.calls).toHaveLength(0); // a clean merge never escalates

      // isolation: the disabled workspace is a no-op even with a recorded issue.
      await engine.recordIssue(wDisabled.workspaceId, {
        issueRef: "github:acme/web#9",
        issueTitle: "x",
        agentOk: true,
        targetChannelId: wDisabled.channelId,
        targetAgentMemberId: wDisabled.agentMemberId,
      });
      expect((await engine.tickWorkspace(wDisabled.workspaceId, new Date())).skipped).toBe("disabled");
      const disabledRow = await buildLoopRunStore.getByIssueRef(wDisabled.workspaceId, "github:acme/web#9");
      expect(disabledRow?.status).toBe("queued");
    },
  );

  it(
    "escalates a protected-path PR instead of merging, escalates after max review rounds, and redacts the " +
      "persisted review findings",
    async () => {
      const w = await seed();
      const enabled = new Set([w.workspaceId]);
      const repo = fakeRepo();
      const launcher = fakeLauncher();
      const escalator = fakeEscalator();

      const SECRET = "s3cr3t-build-token-value-xyz";
      // A reviewer that always PASSes (so the merge GUARDRAIL — not the rubric — is what escalates), and
      // whose summary embeds a secret (must be redacted before it is persisted/escalated).
      const passReviewer: Reviewer = {
        review: async (): Promise<ReviewAssessment> => ({
          verdict: "pass",
          summary: `looks good; token ${SECRET}`,
          checks: [{ id: "gates_intact", ok: true, detail: "n/a" }],
        }),
      };
      const engine = makeEngine({
        repo: repo.host,
        launcher: launcher.launcher,
        escalator: escalator.escalator,
        reviewer: passReviewer,
        enabled,
        killSwitchOn: new Set(),
        redact: (t) => makeRedactor({ TOKEN: SECRET })(t),
        caps: { maxConcurrentBuilds: 5 },
      });

      // A PR that PASSes review but touches a PROTECTED path → the merge guardrail must escalate, not merge.
      await engine.recordIssue(w.workspaceId, {
        issueRef: "github:acme/web#20",
        issueTitle: "Touches billing",
        agentOk: true,
        targetChannelId: w.channelId,
        targetAgentMemberId: w.agentMemberId,
      });
      await engine.tickWorkspace(w.workspaceId, new Date()); // dispatch build
      repo.openPr("github:acme/web#20", {
        files: ["apps/server/src/billing/provider.ts", "apps/server/test/x.test.ts"],
        additions: 10,
        deletions: 0,
        addedLines: ["// touch billing"],
      });
      await engine.tickWorkspace(w.workspaceId, new Date()); // building → reviewing
      await engine.tickWorkspace(w.workspaceId, new Date()); // review PASS → merge-eval → ESCALATE

      const escalated = await buildLoopRunStore.getByIssueRef(w.workspaceId, "github:acme/web#20");
      expect(escalated?.status).toBe("escalated");
      expect(escalated?.escalationReason).toBe("protected_path");
      expect(repo.merges).toHaveLength(0); // NEVER merged a protected-path PR
      expect(escalator.calls.some((c) => c.reason === "protected_path")).toBe(true);

      // redaction: the secret never reaches the persisted review row nor the escalation summary.
      const reviews = await db
        .select()
        .from(buildLoopReviews)
        .where(eq(buildLoopReviews.workspaceId, w.workspaceId));
      expect(reviews.every((r) => !r.summary.includes(SECRET) && !r.findings.includes(SECRET))).toBe(true);
      expect(escalator.calls.every((c) => !c.summary.includes(SECRET))).toBe(true);

      // (B) a FAIL→revise→escalate path on a SEPARATE run with a reviewer that always FAILs.
      const failReviewer: Reviewer = {
        review: async (): Promise<ReviewAssessment> => ({
          verdict: "fail",
          summary: "no tests",
          checks: [{ id: "tests_present", ok: false, detail: "no test" }],
        }),
      };
      const engine2 = makeEngine({
        repo: repo.host,
        launcher: launcher.launcher,
        escalator: escalator.escalator,
        reviewer: failReviewer,
        enabled,
        killSwitchOn: new Set(),
        caps: { maxConcurrentBuilds: 5, maxReviewRounds: 2 },
      });
      await engine2.recordIssue(w.workspaceId, {
        issueRef: "github:acme/web#21",
        issueTitle: "Keeps failing review",
        agentOk: true,
        targetChannelId: w.channelId,
        targetAgentMemberId: w.agentMemberId,
      });
      await engine2.tickWorkspace(w.workspaceId, new Date()); // dispatch
      repo.openPr("github:acme/web#21", cleanDiff(21));
      await engine2.tickWorkspace(w.workspaceId, new Date()); // → reviewing
      await engine2.tickWorkspace(w.workspaceId, new Date()); // review FAIL round 1 → revise
      let r21 = await buildLoopRunStore.getByIssueRef(w.workspaceId, "github:acme/web#21");
      expect(r21?.status).toBe("revising");
      expect(r21?.reviewRounds).toBe(1);
      await engine2.tickWorkspace(w.workspaceId, new Date()); // revising → reviewing (PR re-observed)
      await engine2.tickWorkspace(w.workspaceId, new Date()); // review FAIL round 2 (== max) → ESCALATE
      r21 = await buildLoopRunStore.getByIssueRef(w.workspaceId, "github:acme/web#21");
      expect(r21?.status).toBe("escalated");
      expect(r21?.escalationReason).toBe("max_review_rounds");
    },
  );
});
